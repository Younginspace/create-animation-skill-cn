# 来源、许可证与改造说明

本文件只在维护 Skill 时读取。

## HyperFrames

- 上游：`https://github.com/heygen-com/hyperframes`
- 审计版本：npm `hyperframes@0.7.83`
- Git tag：`v0.7.83`
- Git commit：`5244dde5f10c221221924985aa4651d89fb7c98a`
- 许可证：Apache-2.0

吸收的上游方法：

- 根 composition 的固定尺寸、时长、帧率与 `data-*` 时间声明；
- 可随机寻帧、同一时间产生同一画面的确定性要求；
- 先检查快照再渲染的质量流程；
- `motion-graphics` 中“短、无旁白、动效即信息”的边界；
- `general-video` 中素材包、镜头计划与工程状态的做法；
- `music-to-video` 中本地素材分期和节拍不应压过叙事的原则。
- `hyperframes-creative` 中“先解释提示、再选择视觉”、视频画面区别于网页布局、背景/中景/前景职责、文字层级和 `build → breathe → resolve` 的创意方法。

`references/creative-direction.md` 是依据上述方法重新编写的中文 C 端短动画规范，并针对群聊、家庭事务、中文排版、国内离线字体和克制装饰做了改造。未直接复制上游 Skill 的英文长流程、subagent 编排、远程素材搜索、地图、网站抓取、HeyGen/TTS、英文 ASR、抠像权重下载和 CDN 依赖。脚手架脚本与基线 composition 为本次改造新写。

## `personal-plan` 范式

参考对象：用户提供的本地 `personal-plan` Skill（评审时位于受控参考目录；不把执行机绝对路径写入交付 Skill）。

吸收的结构原则：

- `SKILL.md` 只放路由、最低输入、主流程、工具规则和质量边界；
- 分支规则放在一层 references；
- 易错且重复的操作固化为本地脚本；
- 外部来源与许可证单独记录，运行时不加载；
- 不承诺跨会话状态、自动发布或不存在的能力。

没有复制其个人规划领域内容或校验脚本。
