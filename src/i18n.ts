import type { AppLanguage } from "../electron/core/types";

const spanish: Record<string, string> = {
  "Home": "Inicio",
  "Transfers": "Transferencias",
  "Gallery": "Galería",
  "Send to iPhone": "Enviar al iPhone",
  "Private Links": "Enlaces privados",
  "Sync & Backup": "Sincronización y copias",
  "Producer Studio": "Estudio de producción",
  "Clipboard": "Portapapeles",
  "USB Import": "Importación USB",
  "USB Files": "Archivos USB",
  "Vault": "Caja fuerte",
  "Settings": "Ajustes",
  "Local & private": "Local y privado",
  "Nothing goes to the cloud": "Nada va a la nube",
  "Ready to connect": "Listo para conectar",
  "Offline": "Sin conexión",
  "Good to see you, Doc.": "Qué gusto verte, Doc.",
  "Your iPhone bridge is ready.": "Tu puente para iPhone está listo.",
  "Transfer history": "Historial de transferencias",
  "Everything that moved through PocketDock.": "Todo lo que pasó por PocketDock.",
  "Media gallery": "Galería multimedia",
  "Preview photos, videos, documents, and audio.": "Previsualiza fotos, videos, documentos y audio.",
  "Make PC files available in your iPhone browser.": "Pon archivos de tu PC a disposición del navegador de tu iPhone.",
  "Private links": "Enlaces privados",
  "Encrypted, expiring downloads with hard limits.": "Descargas cifradas que caducan y tienen límites.",
  "Sync & backup": "Sincronización y copias",
  "Automatic folders, Camera Roll profiles, and remote access.": "Carpetas automáticas, perfiles de fotos y acceso remoto.",
  "Package beats, stems, artwork, and project files.": "Empaqueta beats, stems, portadas y proyectos.",
  "Shared clipboard": "Portapapeles compartido",
  "Move text and links between devices.": "Mueve texto y enlaces entre dispositivos.",
  "USB photo import": "Importación de fotos por USB",
  "Import Camera Roll items over a cable.": "Importa fotos y videos mediante cable.",
  "Encrypted vault": "Caja fuerte cifrada",
  "Files protected at rest with your passphrase.": "Archivos protegidos con tu frase de acceso.",
  "Make PocketDock work your way.": "Configura PocketDock a tu manera.",
  "Starting your private file bridge…": "Iniciando tu puente privado de archivos…",
  "Language": "Idioma",
  "The interface follows Windows unless overridden.": "La interfaz usa el idioma de Windows salvo que lo cambies.",
  "Windows default": "Predeterminado de Windows"
};

export function resolvedLanguage(language: AppLanguage): "en" | "es" {
  if (language === "en" || language === "es") return language;
  return navigator.language.toLowerCase().startsWith("es") ? "es" : "en";
}

export function translate(value: string, language: AppLanguage): string {
  return resolvedLanguage(language) === "es" ? spanish[value] ?? value : value;
}
