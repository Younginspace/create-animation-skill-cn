# `creative-plan.json` 契约

脚手架生成的创意计划是 composition 的设计依据，也是质量检查证据。新工程的 `hyperframes.json` 必须声明 `creative_contract_version: 1` 和 `creative_engine_version: 2`。

## 必需字段

- `version: 1`
- `source: "create-animation-cn-creative"`
- `creative_director`：记录自动美学路由版本、输入信号与判断；`engine` 必须是 `cn-context-router-v2`，`auto_applied` 必须为 `true`
  - `signals`：至少三个真实 brief 信号，例如功能、风格、使用场景、视觉变体或受众上下文
  - `decision`：必须明确受众、语气、构图模式、视觉隐喻、`source-only` 文案策略和0—12的装饰预算
- `function`：与 delivery brief 一致
- `route`：本次视觉路由
- `concept`：一句话创意解释
- `content`：逐字保存 source title、subtitle、signature，并记录重排后的 `eyebrow` 和 `hero`
- `palette`：五个六位十六进制本地颜色
- `typography`：语气、主次职责、本地字体约束
- `layers`：有职责的背景、中景、前景；真实素材任务可以合并为两层
- `focal_points`：纯文字表情/卡片至少两个，真实素材任务至少一个
- `motion_beats`：必须覆盖 `build`、`breathe`、`resolve`
- `motion_roles`：至少三个不同画面角色，分别说明动作职责、方向或尺度和节奏
- `guardrails`：事实、媒介和离线边界

纯文字表情与无图卡片的 `eyebrow + hero` 只能改变断句和布局，去掉标点与空白后必须与原始标题完全相同。自动创意路由不得补写英文题头、关系称谓、日期、地点或祝福语。

## 修改规则

- 修改 `index.html` 的视觉路由、文字角色、色板、空间层或节奏时，同步修改创意计划。
- 不把计划写成空泛形容词清单。每个层、焦点和节拍都要说明画面职责。
- 技术检查通过不代表创意通过；仍需人工查看首帧、主动作峰值和结束帧。
- `creative-plan.json` 会进入工程摘要。修改后旧的人工批准自动失效。
