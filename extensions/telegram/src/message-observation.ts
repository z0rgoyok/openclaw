import { resolveGlobalMap } from "openclaw/plugin-sdk/global-singleton";

type Conversation = { accountId: string; chatId: string | number; threadId?: string | number };
type Observer = (messageId: number) => void;
const observers = () =>
  resolveGlobalMap<string, Observer>(Symbol.for("openclaw.telegram.activeProgressObserver"));
const key = (scope: Conversation) =>
  JSON.stringify([scope.accountId, String(scope.chatId), String(scope.threadId ?? "")]);

/** One active progress owner per conversation; a displaced owner's cleanup cannot remove its successor. */
export function observeTelegramConversation(scope: Conversation, observer: Observer): () => void {
  const id = key(scope);
  observers().set(id, observer);
  return () => {
    if (observers().get(id) === observer) {
      observers().delete(id);
    }
  };
}

/** Provider observations only; no message body or retained history crosses this boundary. */
export function noteTelegramMessage(scope: Conversation, messageId: number): void {
  if (Number.isSafeInteger(messageId) && messageId > 0) {
    observers().get(key(scope))?.(messageId);
  }
}
