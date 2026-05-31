# Threat Model — the-dudes

Complementa [SECURITY.md](SECURITY.md) (catálogo de controles). Aqui: o que
protegemos, de quem, e o que fica fora do escopo. Última revisão: 2026-05-30.

## Ativos

1. **Conteúdo dos projetos** — mensagens, prompts, tasks, comments, goals,
   system prompts, summaries. **E2EE**: cifrado no cliente com a project key
   AES-256-GCM; o servidor só vê blob `e2e:` opaco.
2. **Credenciais** (API keys, tokens, webhook secrets) — E2EE por projeto
   (cifradas com a project key, servidor não lê) OU, legado, server-side
   AES-256-GCM. Ver [SECURITY.md §7/§16].
3. **Identidade E2EE do usuário** — keypair RSA-OAEP; privkey wrapped por
   PBKDF2 (passphrase + recovery). Nunca chega ao servidor em claro.
4. **Sessões / tokens de daemon** — bearer tokens; sessões em cookie httpOnly.
5. **Filesystem do usuário** — onde os agentes CLI executam.

## Fronteiras de confiança

```
[Browser do usuário]  --TLS-->  [Cloudflare]  -->  [nginx]  -->  [Orchestrator + Postgres]
   (tem project key)                                                (NÃO tem project key)
        |                                                                    |
        |  project key wrapped p/ pubkey do daemon (via server, opaco)       | WSS
        v                                                                    v
[Daemon na máquina do usuário]  --spawn-->  [Agentes CLI]  -->  [Filesystem / /workspace]
   (tem project key em RAM)
```

- **Servidor é semi-confiável.** E2EE garante que um operador (ou atacante)
  com acesso a DB + servidor **não lê conteúdo nem credenciais E2EE**. Lê
  metadados (quem, quando, tamanhos) e credenciais legadas (até migradas).
- **Daemon é confiável** pelo usuário (roda na máquina dele, segura a project
  key). Pode rodar containerizado pra limitar o alcance no filesystem.
- **Agentes CLI são não-confiáveis** quanto a intenção (prompt injection):
  operam sob aprovação manual por padrão.

## Atores / ameaças

| Ator | Ameaça | Mitigação |
|------|--------|-----------|
| Operador/insider do servidor | Ler conteúdo/credenciais do DB | E2EE (server não tem a project key); creds E2EE; backup GPG offline |
| Atacante de rede | MITM, tamper no download do daemon | TLS; SHA-256 + **assinatura Ed25519** dos bundles (chave privada offline) |
| Servidor comprometido | Servir daemon adulterado | Assinatura Ed25519 — privada não está no servidor; pubkey verificável no repo OSS |
| Prompt injection no agente | Exfiltrar credencial, comando destrutivo | Aprovação manual (default); allowlist MCP; `get_credential` rate-limited + auditado; redact de credencial no egresso (server e daemon); `agent_access` por credencial |
| Agente / código malicioso | Ler/escrever fora do escopo | Container (workspace-root scoping, não-root, cap-drop); drop de privilégio; FORBIDDEN_PATHS |
| Tenant A | Falar por / ler agente do tenant B | `agentBelongsToUser` em todos os handlers WS; isolamento por sessão |
| Atacante com cookie roubado | Sequestro de sessão | cookie httpOnly + Secure (prod); Origin allowlist no WS; tokens revogáveis |
| Atacante via SSRF | Bater em metadata/loopback via webhook | `checkOutboundUrl` (bloqueia loopback/RFC1918/link-local/metadata) |
| Força bruta / DoS de cliente | Flood de auth/bridge/WS | rate-limits por user/IP/agente; frame cap; fail2ban; iptables só Cloudflare |

## Residual / fora de escopo

- **Endpoint do usuário comprometido** (malware no browser/máquina): a project
  key está em RAM no cliente/daemon — fora do nosso alcance.
- **Container escape via exploit de kernel**: o container é defesa em
  profundidade, não um cofre. No Docker Desktop (macOS) há a VM no meio.
- **Prompt injection dentro do `/workspace`**: o agente pode danificar o que
  está montado ali; mitigado por aprovação manual + escopo do mount.
- **TOFU na pubkey de assinatura**: a pubkey é servida pelo servidor +
  committada no repo. Verificação totalmente independente exige obter a pubkey
  por canal separado (repo OSS, site, etc).
- **Credenciais legadas (não migradas)**: ainda server-side — migrar para E2EE
  pela UI fecha o gap.
- **Metadados**: tamanhos, timing, grafo de quem-fala-com-quem não são
  protegidos por E2EE.

## Reporte
Ver [SECURITY.md §Reportar vulnerabilidades]. Zero-day em E2EE/identidade:
contato direto antes de disclosure público.
