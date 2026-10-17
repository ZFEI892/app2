# 试卷批改专属 App

教师自用的试卷 AI 批改工具：**本机浏览器运行、离线优先**，把整张答题卡拍照上传，由 AI 看卷判分、报错题、出成绩，全程数据只存在你自己的电脑上。

## 功能

- **评分标准**：录入题干、参考答案、评分标准（分项得分点 / 一段文字说明两种）、分值。
- **试卷**：挑题建卷，给一个整卷总分，AI 自动按权重把总分分到每道大题、再平均分到小题，可手改。
- **提交**：主路径是「图片答卷」——不用出题，填个卷名、选学生、交一组答题卡照片即可；另有老师代录、学生自填。
- **批改**：AI 看整组照片给一个整卷总分 + 一份错题清单（每道错题带扣分，总分 = 满分 − 扣分之和）；支持一键批量批改、老师逐份复核改分、确认锁定。
- **统计**：班级平均分、及格率、每题得分率、学生排名。
- **数据安全**：单文件 SQLite + 附件目录，一键备份 / 恢复。

## 技术栈

- **运行时**：Node.js ≥ 22.5（用到内置的 `node:sqlite`）
- **零第三方依赖**：后端 `node:http` + 自写轻量路由，数据库用 `node:sqlite`，备份用内置 `zlib` 打包 zip
- **前端**：原生 HTML / CSS / JS，无构建
- **AI**：阿里云百炼千问（DashScope），OpenAI 兼容接口，默认模型 `qwen3.8-max-0902`

## 快速开始

```bash
# 方式一：双击 启动.bat（Windows）

# 方式二：命令行
node server/index.js
```

启动后浏览器自动打开 `http://127.0.0.1:8756`（端口被占用会自动 +1）。首次使用先到「设置」页填 API Key。

## AI 配置（API Key）

在「设置」页填写你的 DashScope API Key 即可，也可直接编辑配置文件：

- **配置文件位置**：`<用户主目录>/.paper-grading/config.local.json`（Windows 例如 `C:\Users\你\.paper-grading\config.local.json`）
- 内容形如：

```json
{
  "baseUrl": "https://dashscope.aliyuncs.com/compatible-mode/v1",
  "model": "qwen3.8-max-0902",
  "apiKey": "你的 Key"
}
```

> **安全约定**：API Key **只存项目文件夹之外**的私有配置文件里，不进源码、不进数据库、不进备份包。把整个项目文件夹发出去不会泄露 Key。

## 目录结构

```
.
├── server/          后端（http 服务、路由、AI 接入、数据库）
│   ├── ai/          千问调用（真实 + 离线 mock）
│   ├── lib/         提示词、分值计算、zip、级联删除等
│   ├── routes/      各业务接口
│   └── services/    批改核心逻辑
├── web/             前端页面（原生 JS，无构建）
├── test/            自动化测试
├── data/            运行时生成（数据库、照片、备份，已 gitignore）
├── PRD.md           产品需求文档
├── DEV_PLAN.md      开发计划
└── 启动.bat         Windows 一键启动器
```

## 测试

```bash
node --no-warnings --test test/*.test.js
```

## 许可证

未指定。
