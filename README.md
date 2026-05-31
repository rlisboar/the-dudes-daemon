# the-dudes daemon

O **daemon** do [the-dudes](https://the-dudes.com) — roda agentes de CLI
(`claude`, `codex`, `gemini`, `opencode`) na **sua máquina**, sob orquestração
remota, com **criptografia ponta-a-ponta (E2EE)** e **aprovação manual** de
comandos por padrão.

Este repositório é open-source (Apache-2.0) justamente pra você poder
**auditar o que roda na sua máquina** e **verificar** que o binário distribuído
corresponde a este código.

## Por que confiar (e como verificar)

- **E2EE**: o conteúdo dos seus projetos (mensagens, prompts, tasks) e as
  credenciais E2EE são cifrados no cliente com a chave do projeto. O servidor
  **nunca vê o plaintext** — só blobs `e2e:` opacos. O daemon segura a chave do
  projeto **só em RAM** (`daemon-crypto.ts`).
- **Aprovação manual por padrão**: agentes não executam tools destrutivas sem
  você aprovar (`autoApprove=false`). Allowlist de tools MCP.
- **Confinamento**: rode containerizado ([docs/DOCKER.md](docs/DOCKER.md)) e o
  daemon + agentes só enxergam a pasta montada em `/workspace`, como usuário
  **não-root**. Sem container, `THE_DUDES_WORKSPACE_ROOT` limita o alcance no
  filesystem (`workspace.ts`, fail-closed).
- **Drop de privilégio** (`privileges.ts`), **SSRF guard** (`ssrf-guard.ts`),
  sanitização do skill installer (`skills-installer.ts`).
- **Distribuição verificável**: cada bundle tem **SHA-256** + **assinatura
  Ed25519**. A chave privada de assinatura fica **offline** (host de build), a
  pública está em [`signing-pub.pem`](signing-pub.pem). Um servidor comprometido
  **não consegue forjar** uma assinatura válida.

Threat model completo: [docs/THREAT-MODEL.md](docs/THREAT-MODEL.md).

## Verificar a assinatura de um bundle baixado

```sh
# baixe o bundle + a assinatura do orchestrator
curl -fsSL https://the-dudes.com/install/daemon.cjs     -o daemon.cjs
curl -fsSL https://the-dudes.com/install/daemon.cjs.sig -o daemon.cjs.sig

# verifique contra a chave pública DESTE repo (não a servida pelo orchestrator)
node -e 'const{verify}=require("crypto"),fs=require("fs");
process.exit(verify(null,fs.readFileSync("daemon.cjs"),fs.readFileSync("signing-pub.pem"),
Buffer.from(fs.readFileSync("daemon.cjs.sig","utf8").trim(),"base64"))?0:1)' \
  && echo "✓ assinatura válida" || echo "✗ ASSINATURA INVÁLIDA"
```

## Build (reproduzível)

`esbuild` é pinado numa versão exata; o bundle é determinístico dado o mesmo
input. Sem `SENTRY_DSN_DAEMON`, a telemetria nasce desligada.

```sh
npm ci
npm run build        # → dist/daemon.cjs + dist/mcp-bridge.cjs (+ .sig se houver chave de assinatura)
```

Assinar no build (opcional): `THE_DUDES_SIGN_KEY_FILE=/caminho/sign.key npm run build`.

## Rodar

```sh
# nativo
THE_DUDES_ORCH=https://the-dudes.com THE_DUDES_DAEMON_TOKEN=<token> \
  THE_DUDES_WORKSPACE_ROOT="$HOME/projetos" node dist/daemon.cjs

# ou via instalador (baixa + verifica sha256 + assinatura)
curl -fsSL https://the-dudes.com/install-daemon.sh | THE_DUDES_TOKEN=<token> sh -s -- https://the-dudes.com
```

Docker (recomendado, confinado + não-root): [docs/DOCKER.md](docs/DOCKER.md).

## Configuração (env)

| Var | Descrição |
|-----|-----------|
| `THE_DUDES_ORCH` | URL do orchestrator (ex `https://the-dudes.com`) |
| `THE_DUDES_DAEMON_TOKEN` | token do daemon (gerado na UI, mostrado 1x) |
| `THE_DUDES_DAEMON_NAME` | nome exibido do daemon (default: hostname) |
| `THE_DUDES_WORKSPACE_ROOT` | confina o daemon a este dir (fail-closed) |
| `THE_DUDES_CLAUDE_CONFIG_DIR` | força o config-dir do claude (auth) |
| `SENTRY_DSN_DAEMON` | opcional; sem ela, telemetria off |

## CI / releases

[`.github/workflows/daemon-release.yml`](.github/workflows/daemon-release.yml):
em tag `daemon-v*`, build reproduzível → checksum → **SLSA provenance keyless**
(via OIDC, sem chave privada no CI) → GitHub Release.

Duas mecânicas de autenticidade, ambas verificáveis:

- **Release do GitHub**: provenance SLSA —
  `gh attestation verify daemon.cjs --repo rlisboar/the-dudes-daemon`.
- **Bundle servido pelo orchestrator**: assinatura **Ed25519** com chave
  **privada offline** (nunca entra no CI), verificável contra
  [`signing-pub.pem`](signing-pub.pem) (ver seção acima).

## Licença

Apache-2.0 — ver [LICENSE](LICENSE).
