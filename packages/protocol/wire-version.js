/**
 * Versão do PROTOCOLO de fio entre daemon e orchestrator.
 *
 * O daemon declara a sua no `daemon:hello`; o server compara com a própria.
 * Iguais = as duas pontas falam o mesmo dialeto. Diferente de semver de app
 * (o "0.1.0" do daemon é estático há meses) e diferente de binaryHash (que
 * detecta build desatualizado, não incompatibilidade): este número só muda
 * quando uma mensagem/campo muda de forma INCOMPATÍVEL.
 *
 * Ao quebrar compatibilidade de mensagens, incremente aqui — o painel de
 * monitoramento passa a acusar "incompatíveis" em vez de deixar as pontas
 * falharem em silêncio uma com a outra.
 */
export const WIRE_PROTOCOL_VERSION = 1;
