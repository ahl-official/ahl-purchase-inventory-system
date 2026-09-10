import type { MetadataRoute } from 'next';
export default function manifest(): MetadataRoute.Manifest {
  return { id:'/', name:'AHL Purchase & Inventory', short_name:'AHL Inventory', description:'Purchase and inventory for Head Office and Salon Floor.', start_url:'/', scope:'/', display:'standalone', background_color:'#f8faf9', theme_color:'#0d6464', icons:[{src:'/icons/icon-192.png',sizes:'192x192',type:'image/png',purpose:'any'},{src:'/icons/icon-512.png',sizes:'512x512',type:'image/png',purpose:'any'},{src:'/icons/maskable-512.png',sizes:'512x512',type:'image/png',purpose:'maskable'}] };
}
