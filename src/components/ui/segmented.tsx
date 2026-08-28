import * as React from "react";
import * as ToggleGroupPrimitive from "@radix-ui/react-toggle-group";
import { cn } from "@/lib/utils";

/**
 * Os grupos de chip/tab do console — ordenar, período, linguagem do snippet,
 * abas de importação, preview/response, tema. Todos são escolha única, então
 * saem de um ToggleGroup do Radix: ganham navegação por teclado e papel de
 * radiogroup, que a versão anterior em <div data-action> não tinha.
 *
 * `value` nunca fica vazio: o Radix limpa a seleção ao clicar no item ativo, e
 * aqui isso não é um estado válido — o clique repetido é ignorado.
 */
export interface SegmentedProps<T extends string> {
  value: T;
  onValueChange: (value: T) => void;
  options: ReadonlyArray<{ value: T; label?: React.ReactNode; title?: string }>;
  size?: "chip" | "tab" | "icon";
  /** `soft` (padrão) marca o ativo com accent-soft; `solid` com o azul cheio, para quando o grupo É a ação principal da tela. */
  variant?: "soft" | "solid";
  className?: string;
  "aria-label"?: string;
}

const ACTIVE = {
  soft: "data-[state=on]:bg-accent-soft data-[state=on]:text-accent",
  solid: "data-[state=on]:bg-accent data-[state=on]:text-on-accent",
} as const;

const SIZES = {
  chip: "h-6.5 px-3 text-xs",
  tab: "h-8 px-4 text-[13px]",
  icon: "h-7 flex-1 px-0",
} as const;

export function Segmented<T extends string>({
  value,
  onValueChange,
  options,
  size = "chip",
  variant = "soft",
  className,
  ...rest
}: SegmentedProps<T>) {
  return (
    <ToggleGroupPrimitive.Root
      type="single"
      value={value}
      onValueChange={(next) => {
        if (next) onValueChange(next as T);
      }}
      className={cn("flex items-center gap-1 rounded-md border border-line bg-surface p-1", className)}
      {...rest}
    >
      {options.map((o) => (
        <ToggleGroupPrimitive.Item
          key={o.value}
          value={o.value}
          title={o.title}
          className={cn(
            "flex cursor-pointer items-center justify-center rounded-sm font-medium text-muted outline-none transition-colors",
            "hover:text-text",
            ACTIVE[variant],
            "focus-visible:outline-2 focus-visible:outline-accent focus-visible:outline-offset-1",
            SIZES[size],
          )}
        >
          {o.label ?? o.value}
        </ToggleGroupPrimitive.Item>
      ))}
    </ToggleGroupPrimitive.Root>
  );
}
