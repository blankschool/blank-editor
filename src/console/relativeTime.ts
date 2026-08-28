/**
 * "editado há 2 h" — a data absoluta não é o que se pergunta sobre um design
 * que se acabou de mexer, e é o que fazia o card parecer listagem de servidor.
 *
 * Passa de 7 dias e vira data absoluta: "há 23 dias" já não ajuda a se orientar,
 * "12 de mar." ajuda.
 */
const rtf = new Intl.RelativeTimeFormat("pt-BR", { numeric: "auto", style: "short" });
const absolute = new Intl.DateTimeFormat("pt-BR", { day: "numeric", month: "short" });

export function relativeTime(iso: string): string {
  const then = new Date(iso).getTime();
  // Data ausente ou inválida acontece de verdade: o Postgres pode não ter
  // updated_at numa linha antiga. Melhor não mostrar nada do que mostrar 1970.
  if (!Number.isFinite(then) || then <= 0) return "";

  const seconds = Math.round((then - Date.now()) / 1000);
  const absSeconds = Math.abs(seconds);

  if (absSeconds < 45) return "agora mesmo";
  if (absSeconds < 3600) return rtf.format(Math.round(seconds / 60), "minute");
  if (absSeconds < 86_400) return rtf.format(Math.round(seconds / 3600), "hour");
  if (absSeconds < 7 * 86_400) return rtf.format(Math.round(seconds / 86_400), "day");
  return absolute.format(then);
}
