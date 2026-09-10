/**
 * Sobe o front e a API de render juntos, que é o que "rodar o projeto" quer
 * dizer na prática: sem o servidor em 8787 o Vite faz proxy de /api para o
 * nada, e o console abre vazio ("nenhum design ainda") com o playground sem
 * conseguir renderizar. Era pegadinha garantida ter isso em dois terminais.
 *
 * Sem dependência nova (nada de concurrently) por um motivo específico: o que
 * mais importa aqui é o encerramento. Um `npm run a & npm run b` deixa órfão o
 * processo que não recebeu o Ctrl+C, e a porta 8787 fica presa até você ir
 * caçar o PID. Este script mata os dois no primeiro sinal e sai com o código de
 * quem morreu primeiro.
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const serverDir = join(root, "server");

if (!existsSync(join(serverDir, "node_modules"))) {
  console.error(
    "\n  As dependências do servidor não estão instaladas.\n" +
      "  Rode isto uma vez e tente de novo:\n\n    cd server && npm install\n",
  );
  process.exit(1);
}

const COLORS = { web: "\x1b[36m", api: "\x1b[35m", dim: "\x1b[2m", reset: "\x1b[0m" };

/**
 * Checagem de porta antes de subir nada.
 *
 * Sem ela, os dois modos de falha são péssimos de diagnosticar: a API morre com
 * um dump cru de EADDRINUSE, e o Vite (antes do strictPort no vite.config.ts)
 * migrava em silêncio para 5174 — você abria a 5173, via uma instância antiga e
 * jurava que a mudança não tinha funcionado. Aqui a mensagem diz qual processo
 * está na frente e como resolver.
 */
async function portOwner(port) {
  const { execFile } = await import("node:child_process");
  return new Promise((resolve) => {
    // -sTCP:LISTEN é obrigatório: sem ele o lsof também casa CONEXÕES para a
    // porta, e o primeiro PID da lista vira o navegador (ou o Cursor) que tem
    // uma aba aberta em 5173 — mandar matar esse é conselho ativamente ruim.
    execFile("lsof", ["-ti", `:${port}`, "-sTCP:LISTEN"], (error, stdout) => {
      const pid = stdout.trim().split("\n")[0];
      if (error || !pid) return resolve(null);
      execFile("ps", ["-o", "command=", "-p", pid], (psError, psOut) => {
        resolve({ pid, command: psError ? "processo desconhecido" : psOut.trim() });
      });
    });
  });
}

const busy = (await Promise.all([portOwner(5173), portOwner(8787)]))
  .map((owner, i) => (owner ? { port: [5173, 8787][i], ...owner } : null))
  .filter(Boolean);

if (busy.length) {
  console.error("\n  Porta ocupada — não vou subir por cima de outra instância:\n");
  for (const { port, pid, command } of busy) {
    console.error(`    :${port}  pid ${pid}  ${command.slice(0, 90)}`);
  }
  console.error(`\n  Encerre e tente de novo:\n\n    kill ${busy.map((b) => b.pid).join(" ")}\n`);
  process.exit(1);
}

/** Prefixa cada linha com quem falou, para dois logs num terminal não virarem sopa. */
function pipe(stream, label) {
  let carry = "";
  stream.setEncoding("utf8");
  stream.on("data", (chunk) => {
    const lines = (carry + chunk).split("\n");
    carry = lines.pop() ?? "";
    for (const line of lines) {
      process.stdout.write(`${COLORS[label]}${label}${COLORS.reset} ${COLORS.dim}│${COLORS.reset} ${line}\n`);
    }
  });
}

const children = [];
let shuttingDown = false;

function start(label, command, args, options) {
  const child = spawn(command, args, { cwd: options.cwd, env: options.env, stdio: ["ignore", "pipe", "pipe"] });
  pipe(child.stdout, label);
  pipe(child.stderr, label);
  child.on("exit", (code, signal) => {
    if (shuttingDown) return;
    console.log(`\n  ${label} saiu (${signal ?? `código ${code}`}). Encerrando o outro.\n`);
    shutdown(code ?? 1);
  });
  children.push(child);
  return child;
}

function shutdown(code) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const child of children) {
    if (child.exitCode === null) child.kill("SIGTERM");
  }
  // Prazo curto para saída limpa; quem ignorar o SIGTERM leva SIGKILL, senão a
  // 8787 fica ocupada e o próximo `npm run dev` falha sem explicar por quê.
  setTimeout(() => {
    for (const child of children) {
      if (child.exitCode === null) child.kill("SIGKILL");
    }
    process.exit(code);
  }, 1500).unref();
  process.exitCode = code;
}

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => shutdown(0));
}

console.log(
  `\n  ${COLORS.web}web${COLORS.reset} http://localhost:5173` +
    `   ${COLORS.api}api${COLORS.reset} http://127.0.0.1:8787` +
    `\n  ${COLORS.dim}chave local: blk_local_dev · Ctrl+C encerra os dois${COLORS.reset}\n`,
);

start("api", process.execPath, ["src/server.ts"], {
  cwd: serverDir,
  // Mesma configuração do `dev:local` do servidor: sem Postgres, templates em
  // memória, e a chave fixa que o playground e o curl usam. PORT force pra
  // 8787 é deliberado, não redundante: um `PORT` já setado no ambiente de
  // quem chamou `npm run dev` (por exemplo uma ferramenta de preview que
  // exporta PORT=5173 pra combinar com o Vite) vazaria pelo `...process.env`
  // e faria a API tentar subir na MESMA porta do Vite — o proxy de /api do
  // vite.config.ts aponta pra 127.0.0.1:8787 fixo, então sem isto ele erra
  // com ECONNREFUSED e o console abre "vazio" sem explicar por quê.
  //
  // DATABASE_URL também precisa ser apagado explicitamente: server/src/server.ts
  // carrega server/.env no bootstrap, e um banco local/túnel configurado ali
  // venceria o LOCAL_API_KEY e tiraria o dev do modo em memória.
  env: { ...process.env, DATABASE_URL: "", LOCAL_API_KEY: "blk_local_dev", PORT: "8787" },
});

start("web", process.execPath, [join(root, "node_modules", "vite", "bin", "vite.js")], {
  cwd: root,
  env: process.env,
});
