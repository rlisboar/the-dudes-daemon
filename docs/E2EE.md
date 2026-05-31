# Criptografia ponta-a-ponta (E2EE)

The Dudes cifra o conteúdo dos seus projetos no seu navegador antes de
chegar ao nosso servidor. Mesmo nossa equipe — operadores do servidor,
super admins, ou quem tiver acesso direto ao banco — não consegue ler:

- Mensagens entre você e os agentes
- Mensagens entre agentes (agent → agent via MCP bridge)
- Saída do CLI dos agentes (assistant text + thinking blocks)
- System prompts dos agentes
- Tasks (título + descrição), comentários, goals
- Resumos TTS (entrada + saída do summarizer)

## Como funciona

### Identidade (Fase 1)

Na primeira vez que você loga via Google, geramos um par de chaves
RSA-OAEP-2048 **no seu navegador**. A chave privada é cifrada com uma
senha master que você define — derivamos a key encryption key (KEK)
via PBKDF2-SHA256 com 600.000 iterações. O servidor armazena:

- Sua chave pública (SPKI base64)
- Sua chave privada cifrada com a KEK da senha
- Sua chave privada cifrada com a KEK do código de recuperação
- O salt PBKDF2
- O hash SHA-256 do código de recuperação

O servidor **nunca** recebe a senha master, o código de recuperação,
ou a chave privada em texto plano.

### Chave por projeto (Fase 2)

Quando você cria um projeto, geramos uma chave AES-256 aleatória
(também no navegador). Ciframos a chave com a sua chave pública RSA e
mandamos pro servidor. Quando admin adiciona um membro novo, o cliente
busca a pubkey desse membro, refaz o wrap e envia a cópia cifrada para
ele. Cada membro só decifra com sua própria chave privada.

### Conteúdo (Fases 3 + 4)

Toda escrita de conteúdo passa por `AES-256-GCM` com a chave do projeto:

- **Browser → server** (tasks, comments, goals, mensagem user → agent,
  system prompt do agente): cliente cifra, servidor armazena ciphertext.
- **Daemon ↔ server** (CLI output, agent → agent, tts summary): daemon
  recebe a chave do projeto cifrada com sua própria chave RSA (gerada
  e persistida em `~/.the-dudes/daemon-key.pem`, chmod 600). Decifra
  ao receber dados do servidor, cifra antes de enviar de volta. Chave
  simétrica fica só em RAM, esquecida no shutdown.

### Recuperação

Se você esquecer a senha master, use o código de recuperação (24
caracteres em 6 grupos, mostrado uma vez no setup). Ele desbloqueia
uma cópia separada da sua chave privada. Após reset, geramos um código
novo.

Se você perder **ambos** (senha master e código de recuperação), os
dados cifrados ficam inacessíveis. Não temos como restaurar — é o
trade-off do E2EE.

## O que NÃO está cifrado

- Email, nome, identificador Google (irreduzível pra autenticação)
- IDs, timestamps, relações (membros do projeto, hierarquia agente)
- Metadata de mensagens (de quem pra quem, tipo, quando)
- Status de tasks (todo/doing/done/blocked) — só o conteúdo é cifrado
- Templates de agentes globais (compartilhados entre projetos —
  encryption multi-projeto fica para uma fase futura)

## Camada que o LLM vê

O agente ainda envia seu prompt e mensagens para o LLM provider que
você configurar (Anthropic, OpenAI, xAI, etc). Esse provider vê o
conteúdo em texto plano — é a fronteira do E2EE: **entre você e o
LLM provider que você escolher**.

## Backup da identidade

Sua chave privada vive cifrada no servidor. Os fatores que destrancam
ela vivem só do seu lado:

1. **Senha master** — você lembra
2. **Código de recuperação** — você salva offline (gerenciador de
   senhas, papel, USB criptografado)

Se você usar múltiplos dispositivos, faça login em cada um com a
senha master. O navegador refaz a derivação local.

## Backups do servidor

O backup automático do banco roda diariamente (`/opt/the-dudes/backups`)
e é cifrado com **GPG público**. A chave privada GPG vive offline na
máquina do operador. Mesmo um backup vazado é inútil sem essa chave —
e o ciphertext do conteúdo dentro do banco também precisa da sua
chave RSA pra decifrar.

## Defesas em camadas

| Camada | Garante |
|---|---|
| TLS (Let's Encrypt) | Trânsito browser ↔ server |
| AES-256-GCM por projeto | Dados em repouso (DB, backup) |
| RSA-OAEP-2048 por usuário | Acesso multi-membro ao mesmo projeto |
| GPG no backup | Backup sem chave privada GPG não decifra |
| Tenant isolation (server) | Daemon de user A não pode tocar agentes de user B |
| Password hashing (Google) | Auth — não envolve E2EE |
