(function(){
'use strict';
var $=function(s,r){return (r||document).querySelector(s)},$$=function(s,r){return Array.prototype.slice.call((r||document).querySelectorAll(s))};
var reduce=window.matchMedia&&matchMedia('(prefers-reduced-motion: reduce)').matches;
var fine=window.matchMedia&&matchMedia('(pointer:fine)').matches;
var REPO='AsianDoesCodin/arvan-launcher';

/* ---------- nav ---------- */
var nav=$('header.nav'),prog=$('#progress');
function onScroll(){
  var y=window.scrollY||0;nav.classList.toggle('stuck',y>40);
  var h=document.documentElement.scrollHeight-innerHeight;if(prog)prog.style.width=(h>0?y/h*100:0)+'%';
}
window.addEventListener('scroll',onScroll,{passive:true});onScroll();
var bg=$('#burger'),lk=$('.links');
if(bg)bg.addEventListener('click',function(){lk.classList.toggle('open')});

/* ---------- ornaments: draw on reveal ---------- */
$$('.orn').forEach(function(o){
  o.innerHTML='<line x1="0" y1="10" x2="150" y2="10"/><line x1="210" y1="10" x2="360" y2="10"/><path d="M150 10 L180 0 L210 10 L180 20 Z"/><rect x="176" y="6" width="8" height="8" transform="rotate(45 180 10)"/>';
  o.setAttribute('viewBox','0 0 360 20');
});

/* ---------- reveal on scroll ---------- */
var io='IntersectionObserver' in window?new IntersectionObserver(function(es){es.forEach(function(e){if(e.isIntersecting){e.target.classList.add('shown');io.unobserve(e.target)}})},{threshold:.14,rootMargin:'0px 0px -6% 0px'}):null;
$$('[data-r],.orn').forEach(function(el,i){
  if(!el.style.getPropertyValue('--d')&&el.dataset.r){var sib=$$('[data-r]',el.parentNode).indexOf(el);el.style.setProperty('--d',Math.max(0,sib%6)*.09+'s')}
  io?io.observe(el):el.classList.add('shown')});

/* ---------- counters ---------- */
var cio='IntersectionObserver' in window?new IntersectionObserver(function(es){es.forEach(function(e){if(!e.isIntersecting)return;cio.unobserve(e.target);
  var el=e.target,to=+el.dataset.to,suf=el.dataset.suf||'',t0=performance.now(),dur=1700;
  (function step(t){var k=Math.min(1,(t-t0)/dur),v=Math.round(to*(1-Math.pow(1-k,4)));el.textContent=v+suf;if(k<1)requestAnimationFrame(step)})(t0)})},{threshold:.6}):null;
$$('[data-to]').forEach(function(el){cio?cio.observe(el):el.textContent=el.dataset.to+(el.dataset.suf||'')});

/* ---------- 3D tilt + glare ---------- */
if(fine&&!reduce)$$('.tilt').forEach(function(el){
  var g=document.createElement('div');g.className='glare';el.appendChild(g);
  el.addEventListener('mousemove',function(e){var r=el.getBoundingClientRect(),px=(e.clientX-r.left)/r.width,py=(e.clientY-r.top)/r.height;
    el.classList.add('hot');el.style.transform='perspective(900px) rotateY('+(px-.5)*13+'deg) rotateX('+(.5-py)*13+'deg) translateZ(8px)';
    el.style.setProperty('--mx',px*100+'%');el.style.setProperty('--my',py*100+'%')});
  el.addEventListener('mouseleave',function(){el.classList.remove('hot');el.style.transform=''});
});

/* ---------- rotating words ---------- */
$$('.rot').forEach(function(r){
  var w=$$('span',r),i=0;if(!w.length)return;w[0].classList.add('on');var m=0;w.forEach(function(s){m=Math.max(m,s.textContent.length)});r.style.minWidth=m*.62+'em';
  setInterval(function(){var o=w[i];i=(i+1)%w.length;o.className='off';var n=w[i];n.className='';void n.offsetWidth;n.className='on';setTimeout(function(){o.className=''},650)},2300);
});

/* ---------- video click to play ---------- */
$$('.vwrap').forEach(function(w){
  var v=$('video',w);if(!v)return;
  w.addEventListener('click',function(){if(v.paused){$$('.vwrap video').forEach(function(o){if(o!==v)o.pause()});v.play();v.controls=true;w.classList.add('playing')}});
  v.addEventListener('pause',function(){if(!v.ended&&v.currentTime>0&&!v.seeking){}});
  v.addEventListener('ended',function(){w.classList.remove('playing');v.controls=false});
});

/* ---------- lightbox ---------- */
var lb=$('#lb');
if(lb){
  var li=$('img',lb),lc=$('.cp',lb),set=[],ix=0;
  function show(n){ix=(n+set.length)%set.length;var it=set[ix];li.style.opacity=0;setTimeout(function(){li.src=it.src;lc.textContent=it.cap;li.style.opacity=1},140)}
  function open(items,n){set=items;lb.classList.add('on');requestAnimationFrame(function(){lb.classList.add('vis')});show(n);document.body.style.overflow='hidden'}
  function close(){lb.classList.remove('vis');setTimeout(function(){lb.classList.remove('on');li.removeAttribute('src')},320);document.body.style.overflow=''}
  document.addEventListener('click',function(e){
    var t=e.target.closest('[data-lb]');if(!t)return;
    var pool=$$('[data-lb]').filter(function(x){return !x.classList.contains('hide')&&!x.closest('.dup')});
    var items=pool.map(function(x){return{src:x.dataset.lb,cap:x.dataset.cap||''}});
    var idx=pool.indexOf(t);if(idx<0){items=[{src:t.dataset.lb,cap:t.dataset.cap||''}];idx=0}
    open(items,idx)});
  $('.x',lb).onclick=close;$('.p',lb).onclick=function(e){e.stopPropagation();show(ix-1)};$('.n',lb).onclick=function(e){e.stopPropagation();show(ix+1)};
  lb.addEventListener('click',function(e){if(e.target===lb)close()});
  document.addEventListener('keydown',function(e){if(!lb.classList.contains('on'))return;if(e.key==='Escape')close();if(e.key==='ArrowRight')show(ix+1);if(e.key==='ArrowLeft')show(ix-1)});
  var sx=0;lb.addEventListener('touchstart',function(e){sx=e.touches[0].clientX},{passive:true});
  lb.addEventListener('touchend',function(e){var d=e.changedTouches[0].clientX-sx;if(Math.abs(d)>50)show(ix+(d<0?1:-1))});
}

/* ---------- gallery filters ---------- */
$$('.chip').forEach(function(ch){ch.addEventListener('click',function(){
  $$('.chip').forEach(function(c){c.classList.remove('on')});ch.classList.add('on');var f=ch.dataset.f;
  $$('.gal .item').forEach(function(it){it.classList.toggle('hide',f!=='all'&&it.dataset.t!==f)})})});

/* ---------- faq ---------- */
$$('.q').forEach(function(q){var b=$('button',q),a=$('.a',q);
  b.addEventListener('click',function(){var o=q.classList.toggle('open');a.style.maxHeight=o?a.scrollHeight+'px':0})});

/* ---------- scroll spy ---------- */
var spy=$$('.spy a');
if(spy.length&&'IntersectionObserver' in window){
  var sio=new IntersectionObserver(function(es){es.forEach(function(e){if(e.isIntersecting){spy.forEach(function(a){a.classList.toggle('on',a.getAttribute('href')==='#'+e.target.id)})}})},{rootMargin:'-45% 0px -50% 0px'});
  $$('.chap').forEach(function(c){sio.observe(c)});
}

/* ---------- latest release from GitHub ---------- */
var dl=$$('[data-dl]');
if(dl.length)fetch('https://api.github.com/repos/'+REPO+'/releases/latest').then(function(r){return r.ok?r.json():Promise.reject()}).then(function(rel){
  var a=(rel.assets||[]).filter(function(x){return /Setup.*\.exe$/i.test(x.name)})[0];if(!a)return;
  dl.forEach(function(b){b.href=a.browser_download_url});
  var mb=(a.size/1048576).toFixed(0);
  $$('[data-ver]').forEach(function(e){e.textContent=rel.tag_name});
  $$('[data-size]').forEach(function(e){e.textContent=mb+' MB'});
  $$('[data-date]').forEach(function(e){e.textContent=new Date(rel.published_at).toLocaleDateString(undefined,{year:'numeric',month:'short',day:'numeric'})});
  $$('[data-count]').forEach(function(e){e.textContent=a.download_count});
  $$('[data-meta]').forEach(function(e){e.textContent=rel.tag_name+' · '+mb+' MB · Windows 10/11 64-bit'});
}).catch(function(){});
/* ---------- server status ---------- */
var SRV='139.99.4.216:25581',srvEls=[];
var nl=$('.nav .links'),scta=$('.nav .links a.cta'),sb=$('.nav .brand');
if(nl&&scta){var sp=document.createElement('a');sp.className='srv';sp.href=sb?sb.getAttribute('href').replace('index.html','download.html'):'download.html';sp.innerHTML='<i></i><span>...</span>';nl.insertBefore(sp,scta);srvEls.push([sp,true])}
$$('[data-srv]').forEach(function(e){e.innerHTML='<i></i><span>Checking server...</span>';srvEls.push([e,false])});
function srvShow(s){srvEls.forEach(function(x){var e=x[0],t=e.lastChild;e.classList.remove('on','off');
  if(!s){t.textContent=x[1]?'Status n/a':'Server status unavailable';return}
  if(s.online){e.classList.add('on');t.textContent=x[1]?s.n+' online':'Server online · '+s.n+(s.n===1?' player':' players')}
  else{e.classList.add('off');t.textContent=x[1]?'Offline':'Server offline'}})}
function srvGet(u,f){return fetch(u).then(function(r){return r.ok?r.json():Promise.reject()}).then(function(j){return {online:!!j.online,n:j.players?j.players.online:0,max:j.players?j.players.max:0}})}
function srvPoll(){srvGet('https://api.mcstatus.io/v2/status/java/'+SRV).catch(function(){return srvGet('https://api.mcsrvstat.us/3/'+SRV)}).then(srvShow,function(){srvShow(null)})}
if(srvEls.length){srvPoll();setInterval(srvPoll,60000)}
})();
