const CACHE='abs90-v9';
const ASSETS=['./index.html','./login.html','./manifest.json','./icon.svg'];
self.addEventListener('install',e=>{e.waitUntil(caches.open(CACHE).then(c=>c.addAll(ASSETS)));self.skipWaiting();});
self.addEventListener('activate',e=>{e.waitUntil(caches.keys().then(ks=>Promise.all(ks.filter(k=>k!==CACHE).map(k=>caches.delete(k)))));self.clients.claim();});
self.addEventListener('fetch',e=>{
  const req=e.request;
  const url=new URL(req.url);
  if(url.pathname.startsWith('/api/')){
    e.respondWith(fetch(req));
    return;
  }
  const isDoc = req.mode==='navigate' || req.destination==='document' || req.url.includes('index.html');
  if(isDoc){
    // 네트워크 우선: 항상 최신 앱을 받고, 오프라인이면 캐시 사용
    e.respondWith(fetch(req).then(res=>{
      const cp=res.clone(); caches.open(CACHE).then(c=>c.put('./index.html',cp)); return res;
    }).catch(()=>caches.match('./index.html')));
  } else {
    // 정적 자원: 캐시 우선
    e.respondWith(caches.match(req).then(r=>r||fetch(req).then(res=>{
      const cp=res.clone(); caches.open(CACHE).then(c=>c.put(req,cp)); return res;
    })));
  }
});
