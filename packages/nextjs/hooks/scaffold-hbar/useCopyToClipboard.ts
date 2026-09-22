import { useState } from "react";
import { notification } from "~~/utils/scaffold-hbar";

export const useCopyToClipboard = () => {
  const [isCopiedToClipboard, setIsCopiedToClipboard] = useState(false);

  const copyToClipboard = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setIsCopiedToClipboard(true);
      setTimeout(() => {
        setIsCopiedToClipboard(false);
      }, 800);
    } catch (error: unknown) {
      const reason = error instanceof Error ? error.message : String(error);
      notification.error(`Could not copy to the clipboard: ${reason}`);
    }
  };

  return { copyToClipboard, isCopiedToClipboard };
};
