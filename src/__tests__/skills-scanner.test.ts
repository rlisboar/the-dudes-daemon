import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { scanSkills } from "../skills-scanner.js";

let root: string; // diretório de skills (root.extraSourceRoots)
let outside: string; // alvo de symlink fora do root

before(async () => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "td-skills-"));
  root = path.join(base, "skills");
  outside = path.join(base, "secret");
  await fs.mkdir(root, { recursive: true });
  await fs.mkdir(outside, { recursive: true });
  await fs.writeFile(path.join(outside, "loot.txt"), "---\nname: evil\ndescription: exfil\n---\nconteúdo secreto do host");

  // skill válida
  const valid = path.join(root, "boa-skill");
  await fs.mkdir(valid, { recursive: true });
  await fs.writeFile(path.join(valid, "SKILL.md"), "---\nname: boa-skill\ndescription: faz coisa boa\n---\ncorpo da skill");

  // frontmatter inválido (sem description)
  const invalid = path.join(root, "ruim-skill");
  await fs.mkdir(invalid, { recursive: true });
  await fs.writeFile(path.join(invalid, "SKILL.md"), "---\nname: ruim\n---\nsem description");

  // SKILL.md é symlink pra fora do root (anti-exfil — fix rodada 3)
  const sym = path.join(root, "sym-skill");
  await fs.mkdir(sym, { recursive: true });
  await fs.symlink(path.join(outside, "loot.txt"), path.join(sym, "SKILL.md"));
});

after(async () => {
  if (root) await fs.rm(path.dirname(root), { recursive: true, force: true });
});

test("scanSkills: encontra skill válida com frontmatter", async () => {
  const res = await scanSkills({ workspaceRoot: null, extraSourceRoots: [root] });
  const mine = res.skills.filter((s) => s.path.startsWith(root));
  const boa = mine.find((s) => s.name === "boa-skill");
  assert.ok(boa, "skill válida deve ser encontrada");
  assert.equal(boa!.frontmatter.description, "faz coisa boa");
  assert.equal(boa!.body, "corpo da skill");
});

test("scanSkills: ignora frontmatter inválido (sem description)", async () => {
  const res = await scanSkills({ workspaceRoot: null, extraSourceRoots: [root] });
  const ruim = res.skills.filter((s) => s.path.startsWith(root)).find((s) => s.name === "ruim");
  assert.equal(ruim, undefined, "skill sem description não deve entrar");
});

test("scanSkills: rejeita SKILL.md que é symlink (anti-exfil de arquivo do host)", async () => {
  const res = await scanSkills({ workspaceRoot: null, extraSourceRoots: [root] });
  const mine = res.skills.filter((s) => s.path.startsWith(root));
  const leaked = mine.find((s) => s.body?.includes("conteúdo secreto do host") || s.name === "evil");
  assert.equal(leaked, undefined, "symlink SKILL.md não deve ser lido/exposto");
});
