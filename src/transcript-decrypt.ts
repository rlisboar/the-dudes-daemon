/**
 * T-368 — metade do daemon do canal de transcript do digest, pura e testável:
 * blobs CRUS entram, um plaintext por blob sai na ordem pedida. O plaintext
 * vive só no retorno — nunca em disco, nunca nos erros. Motivos são constantes
 * com contagens: o conteúdo do transcript não entra no log nem no `error`
 * (paridade com o evento de metadados fixos da T-366 — H-092).
 *
 * O bug que isto fecha: o server mandava linhas montadas (`user: e2e:…`) e
 * cortadas a 2000 chars. Com label na frente o `startsWith("e2e:")` falhava e
 * o ciphertext passava verbatim como claro; o corte partia o base64 e a
 * autenticação. A deteção da cifra exige o blob cru — é o contrato do wire.
 */

export type TranscriptDecryptFailure =
  | { ok: false; reason: "no_key"; index: number; cipherCount: number }
  | { ok: false; reason: "aad_or_data"; index: number; cipherCount: number };

export type TranscriptDecryptResult =
  | { ok: true; lines: string[]; cipherCount: number }
  | TranscriptDecryptFailure;

/** Razões constantes para o `transcript:result` — metadados, zero conteúdo. */
export const TRANSCRIPT_DECRYPT_REASONS: Record<"no_key" | "aad_or_data", string> = Object.freeze({
  no_key: "daemon não tem a chave do projeto",
  aad_or_data: "blob cifrado não decriptou (AAD ou dados)",
});

/** Prefixo canónico de cifra v1/v2 (`e2e:`, `e2e:v2:`). */
function isCipher(blob: string): boolean {
  return blob.startsWith("e2e:");
}

export function decryptTranscriptBlobs(
  blobs: string[],
  opts: {
    projectId: string;
    /** `hasProjectKey(projectId)` — separável para teste sem anel global. */
    hasKey: boolean;
    /** Decifração real (decryptForProject com o AAD de messages.content). */
    decrypt: (blob: string, projectId: string) => string | null;
  },
): TranscriptDecryptResult {
  const lines: string[] = [];
  let cipherCount = 0;
  for (let i = 0; i < blobs.length; i++) {
    const blob = blobs[i];
    if (!isCipher(blob)) {
      lines.push(blob);
      continue;
    }
    cipherCount++;
    if (!opts.hasKey) return { ok: false, reason: "no_key", index: i, cipherCount };
    const dec = opts.decrypt(blob, opts.projectId);
    if (dec === null) return { ok: false, reason: "aad_or_data", index: i, cipherCount };
    lines.push(dec);
  }
  return { ok: true, lines, cipherCount };
}
