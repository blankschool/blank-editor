import { Info, Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { copyText, openNamePrompt, purgeKey, revokeKey, set, useConsole } from "./store";

const COLUMNS = "grid grid-cols-[1.2fr_2fr_1fr_92px] gap-4";

const fmtDate = (iso: string) =>
  new Date(iso).toLocaleDateString("pt-BR", { day: "2-digit", month: "short", year: "numeric" });

function NewKeyBanner() {
  const s = useConsole();
  if (!s.newKeySecret) return null;
  const { id, secret } = s.newKeySecret;

  return (
    <div className="flex flex-col gap-2 rounded-md border border-success bg-success-bg px-4 py-3.5">
      <span className="text-xs font-medium">Chave criada — copie agora, ela não será mostrada de novo.</span>
      <div className="flex items-center gap-2">
        <span className="flex-1 overflow-hidden text-ellipsis whitespace-nowrap font-mono text-xs text-text">
          {secret}
        </span>
        <Button variant="outline" size="sm" className="flex-none" onClick={() => copyText(secret, id)}>
          {s.copied === id ? "Copiado" : "Copiar"}
        </Button>
        <Button variant="ghost" size="sm" className="flex-none border border-line" onClick={() => set("newKeySecret", null)}>
          Ok
        </Button>
      </div>
    </div>
  );
}

export function KeysView() {
  const s = useConsole();
  const query = s.search.trim().toLowerCase();
  const visible = query ? s.keys.filter((k) => k.name.toLowerCase().includes(query)) : s.keys;

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4 p-5">
      <div className="flex items-center gap-4">
        <div className="flex flex-col gap-1.5">
          <span className="font-display text-[15px] font-semibold">Chaves de API</span>
          <span className="text-xs text-faint">
            {s.keys.length}
            {s.keys.length === 1 ? " chave" : " chaves"}
          </span>
        </div>
        <div className="flex-1" />
        <Button onClick={() => openNamePrompt("create-key", "Nome da chave (ex: n8n, produção)")}>
          <Plus size={13} strokeWidth={1.8} />
          Criar chave
        </Button>
      </div>

      <NewKeyBanner />

      <div className="overflow-hidden rounded-sm border border-line bg-surface">
        <div
          className={`${COLUMNS} border-b border-line bg-surface-2 px-4 py-2.5 text-[11px] uppercase tracking-[0.04em] text-faint`}
        >
          <span>Nome</span>
          <span>Chave</span>
          <span>Criada em</span>
          <span />
        </div>

        {visible.map((k) => (
          <div
            key={k.id}
            className={`${COLUMNS} items-center border-b border-surface-2 px-4 py-3.5 text-xs ${k.revoked ? "opacity-50" : ""}`}
          >
            <span className="text-text">{k.name}</span>
            <span className="font-mono text-[11px] text-faint">
              {k.id === s.newKeySecret?.id ? "mostrada acima" : "••••••••••••"}
            </span>
            <span className="text-faint">
              {fmtDate(k.createdAt)}
              {k.revoked ? " · revogada" : ""}
            </span>
            {k.revoked ? (
              <Button
                variant="dangerGhost"
                size="icon"
                className="justify-self-end"
                title="Excluir permanentemente"
                aria-label={`Excluir permanentemente a chave ${k.name}`}
                onClick={() => purgeKey(k.id)}
              >
                <Trash2 size={13} strokeWidth={1.4} />
              </Button>
            ) : (
              <Button
                variant="dangerGhost"
                size="sm"
                className="justify-self-end"
                onClick={() => revokeKey(k.id)}
              >
                Revogar
              </Button>
            )}
          </div>
        ))}

        {visible.length === 0 && (
          <div className="p-10 text-center font-mono text-xs text-faint">
            {s.keys.length === 0 ? "nenhuma chave — crie uma pra começar" : "nenhuma chave bate com a busca"}
          </div>
        )}
      </div>

      <div className="flex items-start gap-3 rounded-sm border border-dashed border-line px-4 py-3.5">
        <Info size={15} strokeWidth={1.4} className="mt-px flex-none text-faint" />
        <span className="max-w-[620px] text-xs leading-relaxed text-faint">
          A chave só é mostrada uma vez, no momento em que é criada. Revogar tem efeito imediato.
        </span>
      </div>
    </div>
  );
}
