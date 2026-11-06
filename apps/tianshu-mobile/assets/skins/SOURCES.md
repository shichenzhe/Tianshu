# 精选皮肤壁纸（mobile）

来源：桌面端 `apps/tianshu-desktop/src-react/assets/skins/*.png`（ComfyUI 本地
AI 生成，无版权问题可自由商用；来源/风格/规格见桌面端 SOURCES.md）。

移动端为控制包体压为 JPEG（sips，quality 78，原始 1376×768 不缩放）：

```bash
sips -s format jpeg -s formatOptions 78 \
  <desktop>/src-react/assets/skins/ripple.png --out ripple.jpg   # 同法其余三张
```

| 文件 | 皮肤 | 明暗 |
| --- | --- | --- |
| ripple.jpg | 涟漪 | 浅色 |
| ocean-sky.jpg | 海空 | 浅色 |
| warm-sand.jpg | 暖沙 | 浅色 |
| ink.jpg | 墨韵 | 深色 |

皮肤三元组（hue/mode）以 `src/theme/skins.ts` 为准，与桌面
`skins.ts` 对齐（两端同步纪律）。
