# HyperFrames 制作约束

本文件只在修改脚手架生成的 composition 时读取。

## 固定契约

- 根节点必须静态声明 `data-composition-id`、`data-width`、`data-height`、`data-duration` 和 `data-fps`。
- `data-composition-id` 必须与 `window.__timelines` 的键完全一致。
- 每个视觉片段声明 `data-start`、`data-duration` 和 `data-track-index`。
- 所有帧只能由输入时间决定；禁止用 `Date.now()`、`performance.now()`、未设种子的 `Math.random()`、滚动、鼠标或网络响应控制画面。
- 必需图片与脚本全部放进工程；渲染时不得依赖远程URL。
- 只动画 `opacity`、`transform`、`color`、`backgroundColor`、`borderRadius` 等稳定视觉属性。
- 先完成静态终态，再加入进入和退出动作。

## 非 GSAP 时间线

本 Skill 的基线 composition 使用一个同步注册的时间线适配器：

```js
window.__timelines[id] = {
  duration: () => duration,
  time: () => currentTime,
  seek: (seconds) => applyFrame(seconds),
  play: () => startPreview(),
  pause: () => stopPreview()
};
```

`seek(t)` 必须能在任意顺序调用，并让相同 `t` 产生相同像素。预览用的 `requestAnimationFrame` 只能驱动 `seek`，不能拥有独立视觉状态。

## 中文排版

- 基线使用运行镜像预装且已授权的中文字体，通过 `@font-face local()` 声明；同一生产镜像必须固定字体版本。
- 交付给不同运行环境继续渲染前，先检查目标字体与换行；需要跨机器像素一致时，把已授权字体文件放入工程并改用 `url()`。
- 标题控制在两行内；不依靠 `<br>` 强制正文换行。
- 1080宽画面左右安全边距至少72px；方形至少64px。
- 9:16画面重要信息避开最上方和最下方各10%。
- 文案需要在实际渲染字体下检查；系统字体缺失时必须换成本地授权字体或重新排版。

## 视觉检查

至少看：

- `t=0`：没有闪白、残留或提前出现的元素；
- 主动作峰值：主体完整、文字未被盖住；
- 每次场景切换前后：无空帧、无拉伸；
- `t=duration-1/fps`：非循环作品稳定收束；
- 循环作品首尾：位置、比例、旋转和背景连续。
