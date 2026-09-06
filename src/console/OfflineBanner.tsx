import { useEffect, useState } from "react";

function isOnline(): boolean {
  return typeof navigator === "undefined" || navigator.onLine !== false;
}

export function OfflineBanner() {
  const [online, setOnline] = useState(isOnline);

  useEffect(() => {
    const goOnline = () => setOnline(true);
    const goOffline = () => setOnline(false);
    window.addEventListener("online", goOnline);
    window.addEventListener("offline", goOffline);
    return () => {
      window.removeEventListener("online", goOnline);
      window.removeEventListener("offline", goOffline);
    };
  }, []);

  if (online) return null;

  return (
    <div className="fixed inset-x-0 bottom-0 z-[999] flex items-center justify-center gap-2 bg-amber-600 px-4 py-2 text-center text-sm font-medium text-white">
      Sem conexão com a internet. Suas alterações serão salvas assim que a conexão voltar.
    </div>
  );
}
