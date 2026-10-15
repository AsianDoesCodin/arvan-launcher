(function(){
'use strict';
var $=function(s,r){return (r||document).querySelector(s)},$$=function(s,r){return Array.prototype.slice.call((r||document).querySelectorAll(s))};
var root=document.body.getAttribute('data-root')||'',ver=document.body.getAttribute('data-v')||'';

/* mobile sidebar */
var side=$('#wside'),tg=$('#wtoggle');
if(tg&&side){tg.addEventListener('click',function(e){e.stopPropagation();side.classList.toggle('open')});
  document.addEventListener('click',function(e){if(side.classList.contains('open')&&!side.contains(e.target))side.classList.remove('open')})}

/* table / list filter */
$$('.tf').forEach(function(box){
  var inp=$('.tfin',box),cnt=$('.tfn',box);
  var rows=$$('.ft tbody tr, .qlist .qc, .ft.qlist > section');
  var heads=$$('.wmain h2');
  function run(){
    var q=inp.value.trim().toLowerCase(),shown=0;
    rows.forEach(function(r){var ok=!q||r.textContent.toLowerCase().indexOf(q)>-1;r.classList.toggle('hidden',!ok);if(ok)shown++});
    $$('.tw').forEach(function(tw){var any=$$('tbody tr',tw).some(function(r){return !r.classList.contains('hidden')});tw.classList.toggle('hidden',!any);var h=tw.previousElementSibling;if(h&&h.tagName==='H2')h.classList.toggle('hidden',!any)});
    cnt.textContent=q?shown+' match'+(shown===1?'':'es'):'';
  }
  inp.addEventListener('input',run);
});

/* global search */
var inp=$('#wsearch'),res=$('#wres'),idx=null,loading=false,sel=-1;
function load(cb){if(idx)return cb();if(loading)return;loading=true;
  fetch(root+'search-index.json?v='+ver).then(function(r){return r.json()}).then(function(j){idx=j;cb()}).catch(function(){loading=false})}
function score(e,q,words){
  var t=e.t.toLowerCase(),s=0;
  if(t===q)s+=100;else if(t.indexOf(q)===0)s+=60;else if(t.indexOf(q)>-1)s+=40;
  else{var all=words.every(function(w){return t.indexOf(w)>-1||(e.d||'').toLowerCase().indexOf(w)>-1||(e.c||'').toLowerCase().indexOf(w)>-1});if(!all)return 0;s+=10}
  return s;
}
function render(){
  var q=inp.value.trim().toLowerCase();
  if(q.length<2){res.classList.remove('on');return}
  var words=q.split(/\s+/);
  var hits=idx.map(function(e){return{e:e,s:score(e,q,words)}}).filter(function(x){return x.s>0}).sort(function(a,b){return b.s-a.s}).slice(0,30);
  sel=-1;
  res.innerHTML=hits.length?hits.map(function(h){return '<a href="'+root+h.e.u+'">'+(h.e.i?'<img class="ic" src="'+root+esc(h.e.i)+'?v='+ver+'" alt="">':'')+'<span><b>'+esc(h.e.t)+'</b><small>'+esc(h.e.c)+(h.e.d?' · '+esc(h.e.d):'')+'</small></span></a>'}).join(''):'<div class="none">No results</div>';
  res.classList.add('on');
}
function esc(s){return String(s).replace(/[&<>"]/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]})}
if(inp){
  inp.addEventListener('input',function(){load(render)});
  inp.addEventListener('focus',function(){load(function(){});if(inp.value.length>1)res.classList.add('on')});
  inp.addEventListener('keydown',function(e){
    var as=$$('a',res);if(!as.length)return;
    if(e.key==='ArrowDown'||e.key==='ArrowUp'){e.preventDefault();sel=(sel+(e.key==='ArrowDown'?1:-1)+as.length)%as.length;as.forEach(function(a,i){a.classList.toggle('sel',i===sel)});as[sel].scrollIntoView({block:'nearest'})}
    else if(e.key==='Enter'&&as.length){location.href=(as[sel>=0?sel:0]).href}
    else if(e.key==='Escape'){res.classList.remove('on');inp.blur()}
  });
  document.addEventListener('click',function(e){if(!e.target.closest('.sbox'))res.classList.remove('on')});
  document.addEventListener('keydown',function(e){if(e.key==='/'&&document.activeElement.tagName!=='INPUT'){e.preventDefault();inp.focus()}});
}
})();
