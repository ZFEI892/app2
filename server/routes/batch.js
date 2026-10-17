'use strict';

const { all, get, run, nowIso } = require('../db');
const { HttpError } = require('../router');
const { gradeSubmission } = require('../services/grader');
const { effectiveConfig } = require('../config');

/** 正在跑的任务 id，防止同一任务被并发推进 */
const active = new Set();

function nowMs() {
  return Date.now();
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function jobRow(id) {
  const row = get('SELECT * FROM batch_jobs WHERE id = ?', id);
  if (!row) throw new HttpError(404, '批量任务不存在');
  return row;
}

function safeList(text) {
  try {
    const v = JSON.parse(text);
    return Array.isArray(v) ? v : [];
  } catch (_) {
    return [];
  }
}

function toJob(row) {
  const failed = safeList(row.failed);
  const targets = safeList(row.targets);
  return {
    id: row.id,
    paperId: row.paper_id,
    status: row.status,
    total: row.total,
    done: row.done,
    cursor: row.cursor,
    failedCount: failed.length,
    failed,
    message: row.message || '',
    progressText: `第 ${Math.min(row.done + (row.status === 'done' ? 0 : 1), row.total || 0)} / ${row.total} 份`,
    finished: row.status === 'done' || row.status === 'stopped',
    targetCount: targets.length,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** 批量批改同时并行处理几份，提速（大卷一份要 2 分钟+，串行太慢） */
const CONCURRENCY = 6;

async function processJob(ctx, jobId) {
  if (active.has(jobId)) return;
  active.add(jobId);
  try {
    for (;;) {
      const job = get('SELECT * FROM batch_jobs WHERE id = ?', jobId);
      if (!job || job.status !== 'running') break;
      const targets = safeList(job.targets);
      if (job.cursor >= targets.length) {
        run(
          "UPDATE batch_jobs SET status = 'done', message = ?, updated_at = ? WHERE id = ?",
          safeList(job.failed).length ? '已完成，但有部分答卷失败' : '全部完成',
          nowIso(),
          jobId
        );
        break;
      }
      // 取下一批（最多 CONCURRENCY 份），并行批改
      const batch = targets.slice(job.cursor, job.cursor + CONCURRENCY).map(Number);
      const results = await Promise.allSettled(
        batch.map((sid) => gradeSubmission(ctx, sid, { force: false }))
      );
      results.forEach((r, i) => {
        if (r.status === 'rejected') {
          const failed = safeList(get('SELECT failed FROM batch_jobs WHERE id = ?', jobId).failed);
          failed.push({
            submissionId: batch[i],
            reason: r.reason && r.reason.message ? r.reason.message : String(r.reason),
          });
          run('UPDATE batch_jobs SET failed = ?, updated_at = ? WHERE id = ?', JSON.stringify(failed), nowIso(), jobId);
        }
      });
      run(
        'UPDATE batch_jobs SET cursor = cursor + ?, done = done + ?, updated_at = ? WHERE id = ?',
        batch.length, batch.length, nowIso(), jobId
      );

      const cfg = effectiveConfig(ctx.configDir);
      const delay = Number(cfg.aiDelayMs) || 0;
      if (delay > 0) await sleep(delay);
    }
  } finally {
    active.delete(jobId);
  }
}

/**
 * 服务重启后，上次没跑完的批量任务不能自己接着跑（K6）：
 * 统一恢复为「已暂停」，由用户在界面上点「继续」。
 */
function recoverStaleJobs() {
  const stale = all("SELECT id FROM batch_jobs WHERE status = 'running'");
  if (!stale.length) return 0;
  run(
    "UPDATE batch_jobs SET status = 'paused', message = '服务重启后已暂停，请点「继续」', updated_at = ? WHERE status = 'running'",
    nowIso()
  );
  return stale.length;
}

function register(router) {
  recoverStaleJobs();

  router.post('/api/papers/:pid/grade-batch', (ctx) => {
    const paper = get('SELECT * FROM papers WHERE id = ?', ctx.params.pid);
    if (!paper) throw new HttpError(404, '试卷不存在');

    const runningJob = get(
      "SELECT * FROM batch_jobs WHERE paper_id = ? AND status = 'running' ORDER BY id DESC LIMIT 1",
      paper.id
    );
    if (runningJob) return { job: toJob(runningJob), resumed: true };

    const targets = all(
      `SELECT s.id FROM submissions s
    LEFT JOIN grade_sheets gs ON gs.submission_id = s.id
        WHERE s.paper_id = ? AND s.status = 'submitted'
          AND IFNULL(gs.status, 'ungraded') <> 'confirmed'
        ORDER BY s.id`,
      paper.id
    ).map((r) => r.id);

    if (!targets.length) {
      throw new HttpError(400, '没有需要批改的答卷（已确认的不重复批改）');
    }

    const now = nowIso();
    const info = run(
      `INSERT INTO batch_jobs(paper_id, status, total, done, failed, targets, cursor, message, created_at, updated_at)
       VALUES(?,?,?,?,?,?,?,?,?,?)`,
      paper.id, 'running', targets.length, 0, '[]', JSON.stringify(targets), 0, '正在批量批改…', now, now
    );
    const jobId = Number(info.lastInsertRowid);
    setTimeout(() => { processJob(ctx, jobId).catch(() => {}); }, 0);
    return { job: toJob(jobRow(jobId)) };
  });

  router.get('/api/batch/:jobId', (ctx) => {
    const job = jobRow(ctx.params.jobId);
    return { job: toJob(job), elapsedMs: nowMs() - Date.parse(job.created_at) };
  });

  router.post('/api/batch/:jobId/pause', (ctx) => {
    const job = jobRow(ctx.params.jobId);
    if (job.status !== 'running') throw new HttpError(409, '该任务当前不是进行中，无法暂停。');
    run("UPDATE batch_jobs SET status = 'paused', message = '已暂停', updated_at = ? WHERE id = ?", nowIso(), job.id);
    return { job: toJob(jobRow(job.id)) };
  });

  router.post('/api/batch/:jobId/resume', (ctx) => {
    const job = jobRow(ctx.params.jobId);
    if (job.status !== 'paused') throw new HttpError(409, '只有已暂停的任务才能继续。');
    run("UPDATE batch_jobs SET status = 'running', message = '正在批量批改…', updated_at = ? WHERE id = ?", nowIso(), job.id);
    setTimeout(() => { processJob(ctx, job.id).catch(() => {}); }, 0);
    return { job: toJob(jobRow(job.id)) };
  });

  router.post('/api/batch/:jobId/retry-failed', (ctx) => {
    const job = jobRow(ctx.params.jobId);
    const failed = safeList(job.failed);
    if (!failed.length) throw new HttpError(400, '没有失败的答卷需要重试。');
    const ids = failed.map((f) => f.submissionId);
    run(
      `UPDATE batch_jobs SET status = 'running', targets = ?, total = ?, done = 0, cursor = 0,
              failed = '[]', message = '正在重试失败的答卷…', updated_at = ? WHERE id = ?`,
      JSON.stringify(ids), ids.length, nowIso(), job.id
    );
    setTimeout(() => { processJob(ctx, job.id).catch(() => {}); }, 0);
    return { job: toJob(jobRow(job.id)) };
  });
}

module.exports = { register, processJob, toJob, recoverStaleJobs };
