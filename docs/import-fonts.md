# Imported Fonts

PDF import resolves fonts before creating the editor document. PDF subsets are
never registered as the editable font for a new import.

1. Resolve the original family, weight and italic style. Fontsource packages
   supply Montserrat and Libre Caslon Condensed offline. Other families use the
   Google Fonts Developer API catalog (`GOOGLE_FONTS_API_KEY`, server only).
2. If unavailable, the existing vision matcher (`OPENAI_API_KEY`, server only)
   suggests a similar family from its allowlist. Resolve and validate its actual
   font bytes before accepting the suggestion.
3. If neither succeeds, use the bundled metric/category fallback. Record all
   substitutions in `fontSubstitutions` and display them after import.

The chosen files are stored with a SHA-256 identity and their weight/style in
`Doc.fonts`. Editor and API load the same bytes; rendering never queries the
catalog again. Text replacements retain this family and fit the saved box.
Fontsource assets contain language subsets, not the original PDF's used-glyph
subset. Import checks coverage of the supplied text; no font promises universal
Unicode coverage. The bundled fallback families are Arimo, Tinos, Cousine,
Carlito, Caladea and Inter; licenses accompany the binaries.

Existing designs are not rewritten automatically. Reimport a PDF to adopt this
policy without modifying an existing design.

Deployment requires rebuilding frontend, API and PDF import service. Both font
and AI API keys must remain in server environment configuration, never Vite vars.
