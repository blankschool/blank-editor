# editor.ts — 3 replaces (depois do merge deste PR)

## 1. Remover a aba Páginas do rail

Apague esta linha do array `TABS`:

```
  { id: "pages", label: "Páginas", icon: `<rect x="7" y="3" width="10" height="13" rx="1.3"/><path d="M4.5 19.5h15"/><path d="M4.5 21.5h9"/>` },
```

Se `activeTab === "pages"` em algum lugar, trate como `null` / feche o panel.

## 2. Thumbs do canvas em alta

Em `buildThumbs`, troque:

```
      const c = await renderPageCanvas(p, Math.min(0.2, 150 / p.w));
      thumbs.set(p.id, c.toDataURL("image/jpeg", 0.72));
```

por:

```
      const c = await renderPageCanvas(p, Math.min(1, 720 / p.w));
      thumbs.set(p.id, c.toDataURL("image/jpeg", 0.92));
```

## 3. Autosave visível

No final de `persist()` (dentro do setTimeout, depois do sync), acrescente:

```
    const st = document.getElementById("saveStatus");
    if (st) { st.textContent = "Salvo"; st.dataset.state = "saved"; }
```

No começo de `persist()`, antes do timer:

```
    const st = document.getElementById("saveStatus");
    if (st) { st.textContent = "Salvando…"; st.dataset.state = "saving"; }
```
