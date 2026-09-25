/**
 * HIGIENE (T-375, QA): importar ESTE módulo como PRIMEIRO import de qualquer
 * ficheiro de teste que carregue cli-config (directamente ou via
 * agent-runner). `PROBE_CACHE_PATH` é calculado do `os.homedir()` no LOAD do
 * módulo; com HOME a apontar para um directório descartável criado aqui, as
 * sondas dos testes escrevem a cache nesse scratch e NUNCA na cache real do
 * dono (~/.the-dudes/runner-probe-cache.json).
 *
 * Sem isto, os fixtures de /tmp (binários novos a cada corrida) enchiam o cap
 * de 256 entradas — a QA mediu 245 entradas mortas — e o boot real pagava
 * re-sonda porque as entradas verdadeiras tinham sido expulsas por ordem de
 * inserção.
 */
import { tmpdir } from "./tmp.js";
import path from "node:path";

const scratchHome = tmpdir("the-dudes-scratch-home-");
process.env.HOME = scratchHome;
// CODEX_HOME is a separate inherited override. HOME alone does not prevent
// RunnerRuntimeFiles from following the developer's real Codex home.
process.env.CODEX_HOME = path.join(scratchHome, ".codex");
