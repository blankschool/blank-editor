# Prompt A — aperto que falta no `src/editor.ts`

O wheel Canva JÁ está no main. Troque só estes dois blocos.

## 1. `VIEW_MARGIN` + `clampView`

De:

```
const VIEW_MARGIN = 120;
function clampView() {
  const s = $("stage").getBoundingClientRect();
  const docH = stackHeight() * zoom, docW = stackWidth() * zoom;
  const cy = (s.height - docH) / 2, cx = (s.width - docW) / 2;
  panY = docH + VIEW_MARGIN * 2 <= s.height
    ? clamp(panY, cy - docH * 0.25, cy + docH * 0.25)
    : clamp(panY, s.height - docH - VIEW_MARGIN, VIEW_MARGIN);
  panX = docW + VIEW_MARGIN * 2 <= s.width
    ? clamp(panX, cx - docW * 0.25, cx + docW * 0.25)
    : clamp(panX, s.width - docW - VIEW_MARGIN, VIEW_MARGIN);
}
```

Para:

```
const VIEW_MARGIN = 48;
function clampView() {
  const s = $("stage").getBoundingClientRect();
  const docH = stackHeight() * zoom, docW = stackWidth() * zoom;
  const cy = (s.height - docH) / 2, cx = (s.width - docW) / 2;
  panY = docH <= s.height
    ? cy
    : clamp(panY, s.height - docH - VIEW_MARGIN, VIEW_MARGIN);
  panX = docW <= s.width
    ? cx
    : clamp(panX, s.width - docW - VIEW_MARGIN, VIEW_MARGIN);
}
```

## 2. Wheel — sem pan horizontal solto

De:

```
  panX -= ev.shiftKey ? ev.deltaY : ev.deltaX;
  panY -= ev.shiftKey ? 0 : ev.deltaY;
```

Para:

```
  panX -= ev.shiftKey ? ev.deltaY : 0;
  panY -= ev.shiftKey ? 0 : ev.deltaY;
```
