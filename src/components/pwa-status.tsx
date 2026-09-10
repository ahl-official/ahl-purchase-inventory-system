"use client";
import { useEffect, useState } from 'react';
import { Download, WifiOff } from 'lucide-react';
interface InstallEvent extends Event { prompt():Promise<void>; userChoice:Promise<{outcome:string}>; }
export function PwaStatus() {
  const [offline,setOffline]=useState(false),[install,setInstall]=useState<InstallEvent|null>(null),[ios,setIos]=useState(false),[hint,setHint]=useState(false);
  useEffect(()=>{
    const connection=()=>setOffline(!navigator.onLine),capture=(e:Event)=>{e.preventDefault();setInstall(e as InstallEvent);},installed=()=>setInstall(null);
    window.setTimeout(()=>{connection();setIos(/iPad|iPhone|iPod/.test(navigator.userAgent)&&!window.matchMedia('(display-mode: standalone)').matches);},0);
    window.addEventListener('online',connection);window.addEventListener('offline',connection);window.addEventListener('beforeinstallprompt',capture);window.addEventListener('appinstalled',installed);
    if('serviceWorker' in navigator)void navigator.serviceWorker.register('/sw.js',{scope:'/',updateViaCache:'none'}).catch(()=>{});
    return()=>{window.removeEventListener('online',connection);window.removeEventListener('offline',connection);window.removeEventListener('beforeinstallprompt',capture);window.removeEventListener('appinstalled',installed);};
  },[]);
  return <>{offline&&<div role="status" className="border-b border-amber-200 bg-amber-50 px-4 py-2 text-center text-sm text-amber-900"><WifiOff className="mr-2 inline size-4"/>Offline — reconnect before updating stock.</div>}{(install||ios)&&<div className="flex flex-wrap items-center justify-center gap-2 border-b bg-brand-subtle px-4 py-2 text-xs text-brand"><span>Keep AHL on your home screen</span><button className="inline-flex min-h-8 items-center gap-1 rounded-md px-2 font-semibold underline" onClick={async()=>{if(install){await install.prompt();await install.userChoice;setInstall(null);}else setHint(!hint);}}><Download className="size-3.5"/>Install app</button>{hint&&<span>In Safari, tap Share, then Add to Home Screen.</span>}</div>}</>;
}
