/* Tandem — shared project management for two (or more).
   Data: Supabase (shared, live) or Demo mode (this device only). */
(function(){
"use strict";

/* ================= helpers ================= */
function esc(s){return String(s==null?"":s).replace(/[&<>"']/g,function(c){return{"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]})}
function pad(n){return n<10?"0"+n:""+n}
function ymd(d){return d.getFullYear()+"-"+pad(d.getMonth()+1)+"-"+pad(d.getDate())}
function today(){return ymd(new Date())}
function addDays(n){var d=new Date();d.setDate(d.getDate()+n);return ymd(d)}
function fmtDate(s){if(!s)return"";var d=new Date(String(s).slice(0,10)+"T00:00:00");return d.toLocaleDateString(undefined,{month:"short",day:"numeric"})}
function ago(ts){var s=(Date.now()-new Date(ts).getTime())/1000;if(s<60)return"just now";if(s<3600)return Math.floor(s/60)+"m ago";if(s<86400)return Math.floor(s/3600)+"h ago";return fmtDate(ts)}
function uuid(){if(window.crypto&&crypto.randomUUID)return crypto.randomUUID();return"xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g,function(c){var r=Math.random()*16|0;return(c==="x"?r:(r&3|8)).toString(16)})}
function lsGet(k){try{return localStorage.getItem(k)}catch(e){return null}}
function lsSet(k,v){try{if(v==null)localStorage.removeItem(k);else localStorage.setItem(k,v)}catch(e){}}
var COLORS=["#2a6f97","#e07a2e","#2f855a","#805ad5","#c53030","#b7791f","#319795","#d53f8c"];
function colorFor(id){var h=0;String(id).split("").forEach(function(c){h=(h*31+c.charCodeAt(0))|0});return COLORS[Math.abs(h)%COLORS.length]}
function initials(n){n=(n||"?").trim();var p=n.split(/[\s@._-]+/).filter(Boolean);return((p[0]||"?")[0]+((p[1]||"")[0]||"")).toUpperCase()}

var COLS=["Backlog","To Do","In Progress","Review","Done"];
var PRI=["Must","Should","Could","Wont"];
var PRILABEL={Must:"Must",Should:"Should",Could:"Could",Wont:"Won\'t"};
var POINTS=[1,2,3,5,8,13,21];
var TABLES=["tasks","sprints","risks","decisions","standups","retros","stakeholders","board_items","boards","task_comments"];

/* ================= data layer ================= */
var cfg=window.PMHUB_CONFIG||{};
var conn={url:cfg.supabaseUrl||lsGet("pmhub.url")||"",key:cfg.supabaseAnonKey||lsGet("pmhub.key")||""};
var mode=lsGet("pmhub.mode")||(conn.url&&conn.key?"supabase":"");
var DB=null;

function SupabaseDB(url,key){
  var sb=window.supabase.createClient(url,key,{auth:{persistSession:true,autoRefreshToken:true,detectSessionInUrl:true,flowType:"pkce"}});
  window.TandemAuthCallback=async function(link){try{var u=new URL(link.replace(/^ph\.tandem:\/\//,"https://cb/"));var code=u.searchParams.get("code"),err=u.searchParams.get("error_description");if(err){toast(err);return}if(code){var r=await sb.auth.exchangeCodeForSession(code);if(r.error)throw r.error;await refreshSession();toast("Signed in with Google")}}catch(e){toast("⚠ Google sign-in failed: "+e.message)}};
  var chan=null,nchan=null;
  function ok(r){if(r.error)throw new Error(r.error.message);return r.data}
  return{
    kind:"supabase",
    session:async function(){var r=await sb.auth.getSession();var s=r.data&&r.data.session;return s?{id:s.user.id,email:s.user.email,name:(s.user.user_metadata||{}).name||(s.user.user_metadata||{}).full_name||s.user.email.split("@")[0]}:null},
    onAuth:function(cb){sb.auth.onAuthStateChange(function(){cb()})},
    signUp:async function(email,pw,name){var r=await sb.auth.signUp({email:email,password:pw,options:{data:{name:name}}});if(r.error)throw new Error(r.error.message);return!!(r.data&&r.data.session)},
    signInGoogle:async function(){var native=!!(window.AndroidBridge&&AndroidBridge.openExternal);
      var r=await sb.auth.signInWithOAuth({provider:"google",options:{redirectTo:native?"ph.tandem://auth-callback":location.origin+location.pathname,skipBrowserRedirect:native,queryParams:{prompt:"select_account"}}});
      if(r.error)throw new Error(r.error.message);if(native)AndroidBridge.openExternal(r.data.url)},
    signIn:async function(email,pw){var r=await sb.auth.signInWithPassword({email:email,password:pw});if(r.error)throw new Error(r.error.message)},
    signOut:async function(){await sb.auth.signOut()},
    resetPw:async function(email){var r=await sb.auth.resetPasswordForEmail(email);if(r.error)throw new Error(r.error.message)},
    projects:async function(){return ok(await sb.from("projects").select("*").order("created_at"))},
    createProject:async function(name,uid){return ok(await sb.from("projects").insert({name:name,owner_id:uid}).select().single())},
    updateProject:async function(id,patch){ok(await sb.from("projects").update(patch).eq("id",id))},
    deleteProject:async function(id){ok(await sb.from("projects").delete().eq("id",id))},
    members:async function(pid){var m=ok(await sb.from("project_members").select("user_id,role").eq("project_id",pid));var ids=m.map(function(x){return x.user_id});var ps=ids.length?ok(await sb.from("profiles").select("id,email,name").in("id",ids)):[];return m.map(function(x){var p=ps.filter(function(y){return y.id===x.user_id})[0]||{};return{id:x.user_id,role:x.role,email:p.email||"",name:p.name||p.email||"Member"}})},
    addMember:async function(pid,email){return ok(await sb.rpc("add_member_by_email",{pid:pid,member_email:email}))},
    removeMember:async function(pid,uid){ok(await sb.from("project_members").delete().eq("project_id",pid).eq("user_id",uid))},
    load:async function(pid){var out={};var rs=await Promise.all(TABLES.map(function(t){return sb.from(t).select("*").eq("project_id",pid).order("created_at")}));S.missing={};TABLES.forEach(function(t,i){if(rs[i].error){if(/schema cache|does not exist|PGRST205|42P01/i.test(rs[i].error.message+" "+(rs[i].error.code||""))){S.missing[t]=true;out[t]=[]}else throw new Error(rs[i].error.message)}else out[t]=rs[i].data});return out},
    ins:async function(t,row){return ok(await sb.from(t).insert(row).select().single())},
    upd:async function(t,id,patch){ok(await sb.from(t).update(patch).eq("id",id))},
    del:async function(t,id){ok(await sb.from(t).delete().eq("id",id))},
    listBy:async function(t,col,val){return ok(await sb.from(t).select("*").eq(col,val).order("created_at",{ascending:false}))},
    comments:async function(taskId){return ok(await sb.from("task_comments").select("*").eq("task_id",taskId).order("created_at"))},
    addComment:async function(pid,taskId,body,uid,mentions){var row={project_id:pid,task_id:taskId,body:body,user_id:uid,mentions:mentions||[]};var r=await sb.from("task_comments").insert(row);
      if(r.error&&/mentions/.test(r.error.message)){delete row.mentions;S.noMentionCol=true;r=await sb.from("task_comments").insert(row)}ok(r)},
    updComment:async function(id,body,mentions){var p={body:body,mentions:mentions||[],edited_at:new Date().toISOString()};var r=await sb.from("task_comments").update(p).eq("id",id).select("id");
      if(r.error&&/mentions|edited_at/.test(r.error.message)){r=await sb.from("task_comments").update({body:body}).eq("id",id).select("id")}ok(r);if(!r.data||!r.data.length)throw new Error("Couldn't save the edit (run the latest database update)")},
    notifs:async function(){var r=await sb.from("notifications").select("*").order("created_at",{ascending:false}).limit(60);if(r.error){if(/notifications|relation|schema cache/i.test(r.error.message))return null;throw new Error(r.error.message)}return r.data||[]},
    notifRead:async function(ids){if(!ids.length)return;await sb.from("notifications").update({read_at:new Date().toISOString()}).in("id",ids).is("read_at",null)},
    notifAllRead:async function(){await sb.from("notifications").update({read_at:new Date().toISOString()}).is("read_at",null)},
    dueReminders:async function(){var r=await sb.rpc("my_due_reminders");return r.error?null:(r.data||[])},
    registerDevice:async function(tok){var r=await sb.rpc("register_device",{p_token:tok});if(r.error)throw new Error(r.error.message)},
    conn:function(){return{url:url,key:key}},
    watchNotifs:function(uid,cb){if(nchan){sb.removeChannel(nchan);nchan=null}if(!uid)return;nchan=sb.channel("n-"+uid).on("postgres_changes",{event:"INSERT",schema:"public",table:"notifications",filter:"user_id=eq."+uid},function(pl){cb(pl.new)}).subscribe()},
    mentionsFor:async function(uid){var r=await sb.from("task_comments").select("id,project_id,task_id,user_id,body,created_at").contains("mentions",[uid]).order("created_at",{ascending:false}).limit(40);if(r.error)return[];var cs=r.data||[];if(!cs.length)return[];
      var tids=cs.map(function(c){return c.task_id}).filter(function(v,i,a){return a.indexOf(v)===i}),uids=cs.map(function(c){return c.user_id}).filter(function(v,i,a){return a.indexOf(v)===i});
      var ts=(await sb.from("tasks").select("id,title").in("id",tids)).data||[],ps=(await sb.from("profiles").select("id,name,email").in("id",uids)).data||[];
      return cs.map(function(c){var t=ts.filter(function(x){return x.id===c.task_id})[0]||{},u=ps.filter(function(x){return x.id===c.user_id})[0]||{};return Object.assign({},c,{task_title:t.title||"a task",author:u.name||u.email||"Someone"})})},
    subscribe:function(pid,cb,status){if(chan){sb.removeChannel(chan);chan=null}if(!pid)return;chan=sb.channel("p-"+pid);
      TABLES.concat(["project_members","board_snapshots"]).forEach(function(t){chan=chan.on("postgres_changes",{event:"*",schema:"public",table:t,filter:"project_id=eq."+pid},function(){cb(t)})});
      chan=chan.on("postgres_changes",{event:"*",schema:"public",table:"projects",filter:"id=eq."+pid},function(){cb("projects")});
      chan.subscribe(function(s){status(s==="SUBSCRIBED")})}
  };
}

function LocalDB(){
  var K="pmhub.demo";
  var me={id:"demo-you",email:"you@demo.local",name:"You"};
  var bert={id:"demo-bert",email:"bert@demo.local",name:"Bert"};
  function read(){try{return JSON.parse(lsGet(K))||null}catch(e){return null}}
  var D=read();
  function write(){lsSet(K,JSON.stringify(D))}
  function now(){return new Date().toISOString()}
  if(D&&!D.board_items)D.board_items=[];if(D&&!D.boards)D.boards=[];if(D&&!D.board_snapshots)D.board_snapshots=[];
  if(!D){D={signedIn:false,users:[me,bert],projects:[],members:[],task_comments:[]};TABLES.forEach(function(t){D[t]=[]});seed();write()}
  function seed(){
    var p={id:uuid(),name:"Sample: Launch our study group",owner_id:me.id,wip_limit:3,asks:"",created_at:now(),
      charter:{why:"We both want to get better at project work and interviews, and practicing alone is easy to skip.",goal:"Run 6 weekly study sessions with at least 2 members each, by "+addDays(42),scopeIn:"Session schedule, topic list, shared notes, 2 mock interviews",scopeOut:"Paid courses, recording videos",success:"6 sessions held; both of us rate them 4/5 or better",deadline:addDays(42),sponsor:"David"}};
    D.projects.push(p);D.members.push({project_id:p.id,user_id:me.id,role:"owner"},{project_id:p.id,user_id:bert.id,role:"member"});
    var sp0={id:uuid(),project_id:p.id,name:"Sprint 0",goal:"Agree on goals and set up the project",start_date:addDays(-17),end_date:addDays(-4),status:"Closed",velocity:6,planning_at:addDays(-17)+"T10:00:00",retro_at:addDays(-4)+"T16:00:00",created_at:now()};
    var sp={id:uuid(),project_id:p.id,name:"Sprint 1",goal:"Schedule and topics locked in; first session held",start_date:addDays(-3),end_date:addDays(10),status:"Active",velocity:null,planning_at:addDays(-3)+"T10:00:00",retro_at:addDays(10)+"T16:00:00",created_at:now()};
    D.sprints.push(sp0,sp);
    function t(title,status,pri,pts,who,due,extra){var o={id:uuid(),project_id:p.id,title:title,description:"",acceptance:"",status:status,priority:pri,points:pts,assignee:who,due:due,deps:[],sprint_id:null,done_at:status==="Done"?addDays(-1):null,created_by:me.id,created_at:now(),updated_at:now()};for(var k in extra)o[k]=extra[k];D.tasks.push(o);return o}
    var a=t("Agree on weekly time slot","Done","Must",1,bert.id,addDays(-2),{sprint_id:sp.id,done_at:addDays(-2)});
    t("Write a one-line purpose for the group","Done","Should",2,me.id,addDays(-1),{sprint_id:sp.id,done_at:addDays(-1)});
    t("Pick a meeting platform","Done","Must",2,bert.id,addDays(-6),{sprint_id:sp0.id,done_at:addDays(-6)});
    t("List what each of us wants to learn","Done","Should",3,me.id,addDays(-8),{sprint_id:sp0.id,done_at:addDays(-9)});
    var b=t("Draft 6-week topic list","In Progress","Must",3,me.id,addDays(2),{sprint_id:sp.id,acceptance:"6 topics, one per week\nEach has 1 reading or video\nBoth of us approved it"});
    var c=t("Set up shared notes doc","To Do","Should",2,bert.id,addDays(3),{sprint_id:sp.id});
    t("Run session 1","To Do","Must",3,me.id,addDays(6),{sprint_id:sp.id,deps:[b.id]});
    t("Book a quiet room for mock interviews","Backlog","Could",2,null,null,{});
    t("Prepare mock interview question bank","Backlog","Should",5,bert.id,addDays(14),{});
    var fr={id:uuid(),project_id:p.id,kind:"frame",x:0,y:0,w:440,h:330,text:"💡 Session ideas",color:"yellow",votes:0,z:0,created_by:me.id,created_at:now()};
    var s1={id:uuid(),project_id:p.id,kind:"sticky",x:24,y:62,w:180,h:120,text:"Mock interviews with a timer",color:"yellow",votes:2,z:1,created_by:bert.id,created_at:now()};
    var s2={id:uuid(),project_id:p.id,kind:"sticky",x:230,y:62,w:180,h:120,text:"System design whiteboard night",color:"orange",votes:3,z:2,created_by:me.id,created_at:now()};
    var s3={id:uuid(),project_id:p.id,kind:"sticky",x:24,y:196,w:180,h:110,text:"Read & discuss one case study",color:"green",votes:1,z:3,created_by:bert.id,created_at:now()};
    var fr2={id:uuid(),project_id:p.id,kind:"frame",x:500,y:0,w:300,h:330,text:"❓ Open questions",color:"blue",votes:0,z:0,created_by:me.id,created_at:now()};
    var s4={id:uuid(),project_id:p.id,kind:"sticky",x:560,y:70,w:180,h:110,text:"Online or in person?",color:"blue",votes:0,z:4,created_by:me.id,created_at:now()};
    var bd={id:uuid(),project_id:p.id,name:"Session brainstorm",thumbnail:null,created_by:me.id,created_at:now(),updated_at:now()};D.boards=[bd];D.board_snapshots=[];
    [fr,s1,s2,s3,fr2,s4].forEach(function(o){o.board_id=bd.id});
    D.board_items=[fr,s1,s2,s3,fr2,s4,{id:uuid(),project_id:p.id,board_id:bd.id,kind:"link",x:0,y:0,w:0,h:0,from_id:s2.id,to_id:s4.id,votes:0,z:5,created_at:now()}];
    D.risks.push({id:uuid(),project_id:p.id,title:"Work deadlines cause skipped sessions",prob:4,impact:3,mitigation:"Fixed slot + 24h reschedule rule",owner_name:"Bert",status:"Open",created_at:now()});
    D.stakeholders.push({id:uuid(),project_id:p.id,name:"David",role:"Sponsor / organizer",raci:"A",created_at:now()},{id:uuid(),project_id:p.id,name:"Bert",role:"Co-organizer",raci:"R",created_at:now()});
    D.task_comments.push({id:uuid(),project_id:p.id,task_id:b.id,user_id:bert.id,body:"Can we put <b>system design</b> in week 3?",mentions:[],created_at:now()},
      {id:uuid(),project_id:p.id,task_id:b.id,user_id:bert.id,body:'<span class="mention" data-uid="'+me.id+'">@You</span> I drafted weeks 1–3:<ul><li>Arrays &amp; hashing</li><li>Behavioral stories</li><li>System design basics</li></ul>Thoughts?',mentions:[me.id],created_at:now()});
  }
  function pids(){return D.members.filter(function(m){return m.user_id===me.id}).map(function(m){return m.project_id})}
  function delay(v){return new Promise(function(r){setTimeout(function(){r(v)},30)})}
  return{
    kind:"demo",
    session:async function(){return D.signedIn?me:null},
    onAuth:function(){},
    signIn:async function(){D.signedIn=true;write()},signUp:async function(){D.signedIn=true;write();return true},
    signOut:async function(){D.signedIn=false;write()},resetPw:async function(){},
    projects:async function(){var ids=pids();return delay(D.projects.filter(function(p){return ids.indexOf(p.id)>=0}))},
    createProject:async function(name){var p={id:uuid(),name:name,owner_id:me.id,wip_limit:3,asks:"",charter:{},created_at:now()};D.projects.push(p);D.members.push({project_id:p.id,user_id:me.id,role:"owner"});write();return p},
    updateProject:async function(id,patch){var p=D.projects.filter(function(x){return x.id===id})[0];for(var k in patch)p[k]=patch[k];write()},
    deleteProject:async function(id){D.projects=D.projects.filter(function(x){return x.id!==id});D.members=D.members.filter(function(x){return x.project_id!==id});TABLES.forEach(function(t){D[t]=D[t].filter(function(x){return x.project_id!==id})});write()},
    members:async function(pid){return D.members.filter(function(m){return m.project_id===pid}).map(function(m){var u=D.users.filter(function(x){return x.id===m.user_id})[0];return{id:u.id,role:m.role,email:u.email,name:u.name}})},
    addMember:async function(pid,email){var u=D.users.filter(function(x){return x.email===email.trim().toLowerCase()})[0];if(!u)return"not_found";if(!D.members.some(function(m){return m.project_id===pid&&m.user_id===u.id}))D.members.push({project_id:pid,user_id:u.id,role:"member"});write();return"added"},
    removeMember:async function(pid,uid){D.members=D.members.filter(function(m){return!(m.project_id===pid&&m.user_id===uid)});write()},
    load:async function(pid){var o={};TABLES.forEach(function(t){o[t]=JSON.parse(JSON.stringify(D[t].filter(function(x){return x.project_id===pid})))});return delay(o)},
    ins:async function(t,row){var r=Object.assign({id:uuid(),created_at:now()},row);if(t==="tasks"){r=Object.assign({description:"",acceptance:"",deps:[],sprint_id:null,done_at:null,created_by:me.id,updated_at:now()},r)}if(t==="standups")r.user_id=r.user_id||me.id;D[t].push(r);write();return r},
    upd:async function(t,id,patch){var r=D[t].filter(function(x){return x.id===id})[0];if(r){for(var k in patch)r[k]=patch[k];if(t==="tasks")r.updated_at=now()}write()},
    del:async function(t,id){D[t]=D[t].filter(function(x){return x.id!==id});if(t==="tasks")D.task_comments=D.task_comments.filter(function(c){return c.task_id!==id});write()},
    listBy:async function(t,col,val){return(D[t]||[]).filter(function(x){return x[col]===val}).slice().reverse()},
    comments:async function(taskId){return D.task_comments.filter(function(c){return c.task_id===taskId})},
    addComment:async function(pid,taskId,body,uid,mentions){D.task_comments.push({id:uuid(),project_id:pid,task_id:taskId,user_id:me.id,body:body,mentions:mentions||[],created_at:now()});write()},
    updComment:async function(id,body,mentions){var c=D.task_comments.filter(function(x){return x.id===id})[0];if(c){c.body=body;c.mentions=mentions||[];c.edited_at=now()}write()},
    mentionsFor:async function(uid){return D.task_comments.filter(function(c){return(c.mentions||[]).indexOf(uid)>=0}).slice().reverse().map(function(c){var t=D.tasks.filter(function(x){return x.id===c.task_id})[0]||{},u=D.users.filter(function(x){return x.id===c.user_id})[0]||{};return Object.assign({},c,{task_title:t.title||"a task",author:u.name||"Someone"})})},
    subscribe:function(pid,cb,status){status(false)},
    reset:function(){lsSet(K,null)}
  };
}

/* ================= state ================= */
var S={user:null,projects:[],cur:lsGet("pmhub.cur"),members:[],d:null,tab:lsGet("pmhub.tab")||"board",sub:{},filter:"all",live:false,loading:false};
function P(){return S.projects.filter(function(p){return p.id===S.cur})[0]||null}
function member(id){return S.members.filter(function(m){return m.id===id})[0]}
function mname(id){var m=member(id);return m?m.name:""}
function D(){return S.d||{tasks:[],sprints:[],risks:[],decisions:[],standups:[],retros:[],stakeholders:[]}}

async function boot(){
  applyTheme();
  if(window.PMHUB_DEMO_ONLY)mode="demo";
  if(!mode){renderConnect();return}
  try{DB=mode==="demo"?LocalDB():SupabaseDB(conn.url,conn.key)}catch(e){toast("Couldn\'t start: "+e.message);mode="";lsSet("pmhub.mode",null);renderConnect();return}
  DB.onAuth(function(){refreshSession()});
  await refreshSession();
}
async function refreshSession(){
  var u=null;try{u=await DB.session()}catch(e){}
  if(!u&&window.PMHUB_DEMO_ONLY){await DB.signIn();u=await DB.session()}
  var changed=(u&&u.id)!==(S.user&&S.user.id);S.user=u;
  if(changed&&DB.watchNotifs){try{DB.watchNotifs(u?u.id:null,onLiveNotif)}catch(e){}}
  if(!u){renderAuth();return}
  if(changed||!S.projects.length)await loadProjects();
}
async function loadProjects(){
  try{S.projects=await DB.projects()}catch(e){toast(e.message);S.projects=[]}
  if(!P())S.cur=S.projects[0]?S.projects[0].id:null;
  lsSet("pmhub.cur",S.cur);
  await loadProject();
}
var reloadT=null;
async function loadProject(silent){
  if(silent&&S.wbBusy){S.wbPending=true;return}
  var p=P();if(!p){S.d=null;S.members=[];render();return}
  if(!silent){S.loading=true;render()}
  try{var r=await Promise.all([DB.load(p.id),DB.members(p.id)]);S.d=r[0];S.members=r[1]}catch(e){toast(e.message)}
  S.loading=false;render();syncNative();loadNotifs();
  if(!silent)DB.subscribe(p.id,function(t){clearTimeout(reloadT);reloadT=setTimeout(async function(){if(t==="projects"){try{S.projects=await DB.projects()}catch(e){}}if(t==="task_comments"){if(openTaskId)renderComments(openTaskId);loadNotifs()}if(t==="board_snapshots"&&document.getElementById("snaplist"))renderSnapList();await loadProject(true)},350)},function(on){S.live=on;var el=document.getElementById("liveDot");if(el)el.className="live"+(on?"":" off")})
}
async function act(fn,msg){try{await fn();if(msg)toast(msg)}catch(e){toast("⚠ "+e.message);return false}await loadProject(true);return true}

/* ================= best-practice engine ================= */
function taskById(id){return D().tasks.filter(function(t){return t.id===id})[0]}
function isBlocked(t){return t.status!=="Done"&&(t.deps||[]).some(function(d){var x=taskById(d);return x&&x.status!=="Done"})}
function isOverdue(t){return t.due&&t.status!=="Done"&&t.due<today()}
function critPath(){var tasks=D().tasks,memo={},vis={};function len(t){if(memo[t.id])return memo[t.id];if(vis[t.id])return{v:0};vis[t.id]=1;var best=0,via=null;(t.deps||[]).forEach(function(d){var x=taskById(d);if(x){var v=len(x).v;if(v>best){best=v;via=x.id}}});vis[t.id]=0;memo[t.id]={v:best+(+t.points||1),via:via};return memo[t.id]}
  var end=null,mx=0;tasks.forEach(function(t){if(t.status==="Done")return;var r=len(t);if(r.v>mx&&(t.deps||[]).length){mx=r.v;end=t}});var path={};while(end){path[end.id]=1;var v=memo[end.id]&&memo[end.id].via;end=v?taskById(v):null}return Object.keys(path).length>1?path:{}}
function riskScore(r){return(+r.prob||0)*(+r.impact||0)}
function riskCls(s){return s>=12?"s-hi":s>=6?"s-md":"s-lo"}
function activeSprint(){return D().sprints.filter(function(s){return s.status==="Active"})[0]}
function velocity(){var cs=D().sprints.filter(function(s){return s.status==="Closed"}).slice(-3);if(!cs.length)return 0;return Math.round(cs.reduce(function(a,s){return a+(s.velocity||0)},0)/cs.length)}
function progress(){var tot=0,done=0;D().tasks.forEach(function(t){if(t.priority==="Wont")return;var e=+t.points||1;tot+=e;if(t.status==="Done")done+=e});return tot?Math.round(done/tot*100):0}

function myBrief(){var me=S.user.id,t=D().tasks,td=today();
  var mine=t.filter(function(x){return x.assignee===me&&x.status!=="Done"});
  var dueToday=mine.filter(function(x){return x.due===td}),overdue=mine.filter(function(x){return x.due&&x.due<td}),doing=mine.filter(function(x){return x.status==="In Progress"});
  var review=t.filter(function(x){return x.status==="Review"&&x.assignee&&x.assignee!==me}).length;
  var blockers=D().standups.filter(function(s){return s.user_id!==me&&s.blockers&&s.day>=addDays(-1)}).map(function(s){return mname(s.user_id)+": "+s.blockers});
  var posted=D().standups.some(function(s){return s.user_id===me&&s.day===td});
  return{dueToday:dueToday,overdue:overdue,doing:doing,review:review,blockers:blockers,posted:posted,mine:mine}}
function syncNative(){try{if(!(window.AndroidBridge&&AndroidBridge.saveBrief)||!S.user||!P()||!S.d)return;var b=myBrief();
  AndroidBridge.saveBrief(JSON.stringify({name:S.user.name||"",theme:theme,project:P().name,synced:today(),review:b.review,blockers:b.blockers.slice(0,3),tasks:b.mine.map(function(x){return{t:x.title,due:x.due||"",status:x.status}})}))}catch(e){}}
function hasNative(){return!!(window.AndroidBridge&&AndroidBridge.morningSet)}
function morningCfg(){try{return JSON.parse(AndroidBridge.morningGet())}catch(e){return{on:false,h:8,m:0,perm:true}}}
function briefCard(){if(lsGet("pmhub.brief")===today()+"|"+S.cur)return"";var hr=new Date().getHours();if(hr>=15&&!S.forceBrief)return"";var b=myBrief();
  var greet={classic:"Good morning",pro:"Good morning",squid:"Good morning! Time to make waves",cat:"Rise and shine"}[theme]+(S.user.name?", "+esc(S.user.name.split(" ")[0]):"");
  var lines=[];
  if(b.dueToday.length)lines.push('<li>📅 <b>Due today:</b> '+b.dueToday.slice(0,3).map(function(x){return'<a href="#" data-a="editTask" data-v="'+x.id+'">'+esc(x.title)+'</a>'}).join(", ")+'</li>');
  if(b.overdue.length)lines.push('<li>⚠️ <b>Overdue:</b> '+b.overdue.slice(0,3).map(function(x){return'<a href="#" data-a="editTask" data-v="'+x.id+'">'+esc(x.title)+'</a>'}).join(", ")+'</li>');
  if(b.doing.length)lines.push('<li>▶ <b>In progress:</b> '+b.doing.length+' task(s)</li>');
  if(b.review)lines.push('<li>👀 <b>'+b.review+'</b> waiting for your review</li>');
  b.blockers.slice(0,2).forEach(function(x){lines.push('<li>⛔ '+esc(x)+'</li>')});
  if(!lines.length)lines.push('<li>No deadlines today. Pick your top task.</li>');
  var mc=hasNative()?morningCfg():null;
  return'<div class="card brief"><div class="row between"><div class="row" style="gap:10px;flex-wrap:nowrap">'+((theme!=="classic"&&theme!=="pro")?'<span class="mini">'+MASCOT[theme]+'</span>':theme==="pro"?'':'<span class="sun">☀️</span>')+'<h3 style="margin:0">'+greet+'</h3></div><button class="x" data-a="dismissBrief" aria-label="Dismiss">×</button></div><ul>'+lines.join("")+'</ul>'+
  '<div class="row">'+(b.posted?'<span class="pill st-Done">✓ Standup posted</span>':'<button class="btn small" data-a="goto" data-v="sprint" data-s="standup">Post standup</button>')+(mc&&!mc.on?'<button class="btn ghost small" data-a="menu">🔔 Get this every morning</button>':'')+'</div></div>'}
function health(){
  var p=P(),out=[];if(!p||!S.d)return out;var c=p.charter||{},t=D().tasks;
  function add(sev,msg,guide,tab,sub){out.push({sev:sev,msg:msg,guide:guide,tab:tab,sub:sub})}
  if(!(c.goal||"").trim())add("hi","No project goal yet. Write a SMART goal in the charter.","charter","plan","charter");
  else if(!/\d/.test(c.goal))add("md","The goal has no number or date, so it isn\'t measurable yet.","charter","plan","charter");
  if(!(c.scopeOut||"").trim())add("md","Nothing is listed as out of scope. That\'s an open door for scope creep.","charter","plan","charter");
  if(!(c.success||"").trim())add("md","No success criteria. How will the sponsor judge this project?","charter","plan","charter");
  if(!c.deadline)add("md","No project deadline set.","charter","plan","charter");
  var acc=D().stakeholders.filter(function(x){return x.raci==="A"}).length;
  if(acc===0)add("md","Nobody is Accountable (A) in the stakeholder list. Exactly one person should be.","raci","plan","people");
  if(acc>1)add("md",acc+" people are marked Accountable. There should be exactly one.","raci","plan","people");
  var no=t.filter(function(x){return x.status!=="Done"&&x.status!=="Backlog"&&!x.assignee});
  if(no.length)add("hi",no.length+" planned task(s) have no assignee: "+no.slice(0,3).map(function(x){return"“"+x.title+"”"}).join(", "),"tasks","board");
  var big=t.filter(function(x){return+x.points>=13&&x.status!=="Done"});
  if(big.length)add("md",big.length+" task(s) are 13+ points. Split them: "+big.slice(0,2).map(function(x){return"“"+x.title+"”"}).join(", "),"tasks","board");
  var ne=t.filter(function(x){return!x.points&&x.status!=="Done"&&x.status!=="Backlog"});
  if(ne.length)add("lo",ne.length+" planned task(s) have no estimate.","estimate","board");
  var np=t.filter(function(x){return!x.priority&&x.status!=="Done"});
  if(np.length)add("lo",np.length+" task(s) have no priority.","prio","board");
  if(t.length>=4){var m=t.filter(function(x){return x.priority==="Must"}).length;if(m/t.length>0.6)add("md",Math.round(m/t.length*100)+"% of tasks are Musts. Aim for 60% or less so there\'s buffer.","prio","board")}
  var ip=t.filter(function(x){return x.status==="In Progress"});
  if(ip.length>p.wip_limit)add("hi",ip.length+" tasks in progress, but the WIP limit is "+p.wip_limit+". Finish before starting more.","flow","board");
  S.members.forEach(function(mb){var n=ip.filter(function(x){return x.assignee===mb.id}).length;if(n>=3)add("md",mb.name+" has "+n+" tasks in progress at once. Context switching slows everyone down.","flow","board")});
  var od=t.filter(isOverdue);
  if(od.length)add(od.some(function(x){return x.priority==="Must"})?"hi":"md",od.length+" overdue task(s): "+od.slice(0,3).map(function(x){return"“"+x.title+"”"}).join(", ")+". Re-plan or escalate.","schedule","board");
  var bl=ip.filter(isBlocked);
  if(bl.length)add("hi",bl.length+" task(s) are in progress but blocked by unfinished dependencies.","schedule","board");
  var rv=t.filter(function(x){return x.status==="Review"&&x.updated_at&&(Date.now()-new Date(x.updated_at))>2*864e5});
  if(rv.length)add("md",rv.length+" task(s) have sat in Review for 2+ days. Reviews are the team\'s first priority.","flow","board");
  var na=t.filter(function(x){return(x.status==="In Progress"||x.status==="Review")&&!(x.acceptance||"").trim()});
  if(na.length)add("lo",na.length+" task(s) in progress have no acceptance criteria, so “done” is undefined.","tasks","board");
  if(c.deadline){var late=t.filter(function(x){return x.due&&x.due>c.deadline&&x.priority!=="Wont"});if(late.length)add("md",late.length+" task(s) are due after the project deadline.","schedule","board")}
  if(!D().risks.length)add("md","No risks logged. List at least 3 things that could go wrong.","risk","plan","risks");
  var hr=D().risks.filter(function(r){return r.status==="Open"&&riskScore(r)>=12&&!(r.mitigation||"").trim()});
  if(hr.length)add("hi",hr.length+" high risk(s) have no mitigation plan.","risk","plan","risks");
  var sp=activeSprint();
  if(sp){if(!(sp.goal||"").trim())add("md","The active sprint has no sprint goal.","sprint","sprint","plan");
    if(sp.end_date<today())add("md",sp.name+" ended on "+fmtDate(sp.end_date)+". Close it and hold a retro.","retro","sprint","plan");
    var spPts=t.filter(function(x){return x.sprint_id===sp.id}).reduce(function(a,x){return a+(+x.points||0)},0),v=velocity();
    if(v&&spPts>v*1.25)add("md",sp.name+" has "+spPts+" pts planned but your average velocity is "+v+". Expect to carry work over.","estimate","sprint","plan");
    var last=D().standups.reduce(function(a,s){return s.day>a?s.day:a},"");
    if(!last||last<addDays(-2))add("lo","No standup logged in the last 2 days.","standup","sprint","standup");
    var openActs=[];D().retros.forEach(function(r){((r.data||{}).actions||[]).forEach(function(a){if(!a.done)openActs.push(a)})});
    if(openActs.length)add("lo",openActs.length+" retro action item(s) still open. Did we do what we said we\'d change?","retro","sprint","retro")}
  else if(t.length)add("lo","No active sprint. Short sprints (1–2 weeks) keep you both focused on one goal.","sprint","sprint","plan");
  return out;
}
function rag(){var h=health(),od=D().tasks.filter(isOverdue),hi=h.filter(function(x){return x.sev==="hi"}).length;
  if(od.some(function(x){return x.priority==="Must"})||hi>=3)return"R";if(od.length||hi>0||h.filter(function(x){return x.sev==="md"}).length>=3)return"A";return"G"}

/* ================= UI plumbing ================= */
var IC={
 gear:'<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/></svg>',
 board:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><rect x="3" y="3" width="5" height="18" rx="1.5"/><rect x="10" y="3" width="5" height="12" rx="1.5"/><rect x="17" y="3" width="4" height="8" rx="1.5"/></svg>',
 sprint:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-3-6.7"/><path d="M21 4v5h-5"/></svg>',
 plan:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="5" y="3" width="14" height="18" rx="2"/><path d="M9 8h6M9 12h6M9 16h4"/></svg>',
 coach:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2l2.4 5 5.6.8-4 3.9 1 5.5-5-2.7-5 2.7 1-5.5-4-3.9 5.6-.8z"/></svg>',
 dash:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="8" height="9" rx="2"/><rect x="13" y="3" width="8" height="5" rx="2"/><rect x="13" y="10" width="8" height="11" rx="2"/><rect x="3" y="14" width="8" height="7" rx="2"/></svg>',
 search:'<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><path d="M20 20l-4-4"/></svg>',
 ideas:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18h6M10 21h4M12 3a6 6 0 0 0-3.5 10.9c.6.4 1 1.1 1 1.8V16h5v-.3c0-.7.4-1.4 1-1.8A6 6 0 0 0 12 3z"/></svg>',
 guide:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20V3H6.5A2.5 2.5 0 0 0 4 5.5z"/><path d="M4 19.5V21h16"/></svg>',
 menu:'<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="5" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="12" cy="19" r="1"/></svg>'
};
var MASCOT={
 pro:'<svg viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="4" width="6" height="16" rx="1.5"/><rect x="14" y="4" width="6" height="10" rx="1.5"/></svg>',
 classic:'<svg viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M4 18l5-6 4 3 7-9"/><circle cx="20" cy="6" r="1.5" fill="#fff"/></svg>',
 squid:'<svg viewBox="0 0 64 64" class="m-squid"><g class="sq-legs" stroke="#ff8fb1" stroke-width="4.5" stroke-linecap="round" fill="none"><path d="M24 42c-2 6 1 9-2 15"/><path d="M29.5 43c0 6 2 9 0 15"/><path d="M34.5 43c0 6-2 9 0 15"/><path d="M40 42c2 6-1 9 2 15"/></g><path d="M32 4C22 12 16 22 16 32c0 6 4 10 8 11h16c4-1 8-5 8-11 0-10-6-20-16-28z" fill="#ff8fb1"/><path d="M17 24c-6 1-9 5-10 10 5 0 8-3 10-6zM47 24c6 1 9 5 10 10-5 0-8-3-10-6z" fill="#ff6f9c"/><ellipse cx="32" cy="16" rx="5" ry="3" fill="#ffb3c9" opacity=".7"/><circle cx="26" cy="31" r="5" fill="#fff"/><circle cx="38" cy="31" r="5" fill="#fff"/><circle class="sq-eye" cx="27" cy="32" r="2.4" fill="#1d2430"/><circle class="sq-eye" cx="39" cy="32" r="2.4" fill="#1d2430"/><path d="M29 38q3 2.6 6 0" stroke="#1d2430" stroke-width="1.8" fill="none" stroke-linecap="round"/><circle cx="21.5" cy="37" r="2.2" fill="#ff4f86" opacity=".45"/><circle cx="42.5" cy="37" r="2.2" fill="#ff4f86" opacity=".45"/></svg>',
 cat:'<svg viewBox="0 0 64 64" class="m-cat"><path class="cat-tail" d="M46 52c9 1 14-5 12-13" stroke="#f0a35e" stroke-width="5" fill="none" stroke-linecap="round"/><ellipse cx="32" cy="52" rx="15" ry="9" fill="#f0a35e"/><path class="cat-ear-l" d="M13 26 L16 7 L29 17 Z" fill="#f0a35e"/><path class="cat-ear-r" d="M51 26 L48 7 L35 17 Z" fill="#f0a35e"/><path d="M17 20 L18.5 12 L24 16.5Z M47 20 L45.5 12 L40 16.5Z" fill="#f7c1bd"/><ellipse cx="32" cy="31" rx="20" ry="17" fill="#f0a35e"/><path d="M27 15.5q5 3 10 0M25 19q7 3.5 14 0" stroke="#d9823a" stroke-width="2" fill="none" stroke-linecap="round"/><g class="cat-eyes"><ellipse cx="24.5" cy="30" rx="3" ry="3.6" fill="#2b2118"/><ellipse cx="39.5" cy="30" rx="3" ry="3.6" fill="#2b2118"/><circle cx="25.5" cy="28.8" r="1" fill="#fff"/><circle cx="40.5" cy="28.8" r="1" fill="#fff"/></g><path d="M30.3 35.5h3.4L32 37.5z" fill="#e8747c"/><path d="M32 37.5q-2 3-4.5 1.5M32 37.5q2 3 4.5 1.5" stroke="#2b2118" stroke-width="1.4" fill="none" stroke-linecap="round"/><path d="M14 33l-7-1.5M14 36.5l-7 1.5M50 33l7-1.5M50 36.5l7 1.5" stroke="#5a3e2b" stroke-width="1.2" stroke-linecap="round" opacity=".55"/></svg>'
};
var THEMES={
 classic:{label:"Classic",done:"Done! Nice work.",empty:"Nothing here",loading:"Loading…",allgood:"Nothing to flag. This project is well run."},
 squid:{label:"Squid",done:"Inked it! 🦑",empty:"Calm waters. Nothing here.",loading:"Inking…",allgood:"Smooth sailing. Nothing to flag."},
 pro:{label:"Professional",done:"Completed.",empty:"No items",loading:"Loading…",allgood:"No issues flagged."},
 cat:{label:"Cat",done:"Purr-fect! 🐾",empty:"Nap time. Nothing here.",loading:"Purring…",allgood:"Everything's purring along. Nothing to flag."}
};
var theme=lsGet("pmhub.theme")||"classic";if(!THEMES[theme])theme="classic";
function TH(){return THEMES[theme]}
function applyTheme(){document.documentElement.setAttribute("data-theme",theme);var deco=document.getElementById("deco");if(!deco){deco=document.createElement("div");deco.id="deco";deco.setAttribute("aria-hidden","true");document.body.insertBefore(deco,document.body.firstChild)}
  deco.innerHTML=theme==="squid"?Array.apply(null,Array(14)).map(function(_,i){return'<i style="left:'+((i*37)%100)+'%;--d:'+(9+(i*7)%11)+'s;--s:'+(6+(i*5)%14)+'px;animation-delay:-'+((i*3.1)%12).toFixed(1)+'s"></i>'}).join(""):"";
  var mc=document.querySelector('meta[name=theme-color]');if(mc)mc.content={classic:"#16324f",pro:"#0f172a",squid:"#2b1d5c",cat:"#5a3e2b"}[theme]}
function logo(){return'<div class="logo">'+MASCOT[theme]+'</div>'}
var LOGO="";
var TABS=[["dash","Dashboard"],["board","Board"],["ideas","Ideas"],["sprint","Sprint"],["plan","Plan"],["coach","Coach"],["guide","Guide"]];
var toastT;function toast(m){var d=document.getElementById("toastEl");if(d)d.remove();d=document.createElement("div");d.id="toastEl";d.className="toast";d.textContent=m;document.body.appendChild(d);clearTimeout(toastT);toastT=setTimeout(function(){d.remove()},2800)}
var openTaskId=null;
var modalTok=0;
function reducedMotion(){return window.matchMedia&&window.matchMedia("(prefers-reduced-motion: reduce)").matches}
function modal(html,onMount,opts){modalTok++;var L=document.getElementById("layer");var dr=opts&&opts.drawer&&isDesk();L.innerHTML='<div class="scrim'+(dr?" drawer":"")+'" data-a="closeScrim"><div class="modal" role="dialog"><div class="grab" aria-hidden="true"></div>'+html+'</div></div>';var m=L.querySelector(".modal");wireSheetDrag(m);if(onMount)onMount(m);annotateTerms(m)}
function wireSheetDrag(m){var y0=null,dy=0;m.addEventListener("touchstart",function(e){if(m.scrollTop>0||e.target.closest("input,textarea,select,button"))return;y0=e.touches[0].clientY;dy=0;m.style.transition="none"},{passive:true});
  m.addEventListener("touchmove",function(e){if(y0==null)return;dy=e.touches[0].clientY-y0;if(dy>0)m.style.transform="translateY("+dy+"px)"},{passive:true});
  m.addEventListener("touchend",function(){if(y0==null)return;m.style.transition="";if(dy>110)closeModal();else m.style.transform="";y0=null})}
function closeModal(){openTaskId=null;var L=document.getElementById("layer");var sc=L.querySelector(".scrim");if(!sc)return;if(reducedMotion()){L.innerHTML="";return}var tok=modalTok;sc.classList.add("closing");setTimeout(function(){if(tok===modalTok)L.innerHTML=""},200)}
function buzz(p){try{if(navigator.vibrate)navigator.vibrate(p)}catch(e){}}
function isDesk(){return window.matchMedia&&window.matchMedia("(min-width: 700px)").matches}
function isPhone(){return window.matchMedia&&window.matchMedia("(max-width: 699px)").matches}
function confirmBox(msg,yes,label){modal('<div class="mh"><h3>Are you sure?</h3></div><p>'+esc(msg)+'</p><div class="row" style="justify-content:flex-end"><button class="btn ghost" data-a="close">Cancel</button><button class="btn danger" id="cyes">'+(label||"Yes")+'</button></div>',function(m){m.querySelector("#cyes").onclick=function(){closeModal();yes()}})}
function copyText(txt){try{if(window.AndroidBridge&&window.AndroidBridge.copy)return Promise.resolve(!!window.AndroidBridge.copy(txt))}catch(e){}try{if(navigator.clipboard&&navigator.clipboard.writeText)return navigator.clipboard.writeText(txt).then(function(){return true},function(){return fb(txt)})}catch(e){}return Promise.resolve(fb(txt));function fb(t){try{var a=document.createElement("textarea");a.value=t;a.style.position="fixed";a.style.opacity="0";document.body.appendChild(a);a.select();var ok=document.execCommand("copy");a.remove();return ok}catch(e){return false}}}
function avatar(id,sm){var m=member(id);if(!m)return"";return'<span class="av'+(sm?" sm":"")+'" style="background:'+colorFor(m.id)+'" title="'+esc(m.name)+'">'+esc(initials(m.name))+'</span>'}
function subtabs(key,items,def){var cur=S.sub[key]||def;return'<div class="subtabs">'+items.map(function(s){return'<button class="'+(cur===s[0]?"on":"")+'" data-a="sub" data-k="'+key+'" data-v="'+s[0]+'">'+s[1]+'</button>'}).join("")+'</div>'}

/* ================= screens: connect & auth ================= */
function renderConnect(){
  document.getElementById("tabs").innerHTML="";
  document.getElementById("app").innerHTML='<div class="auth">'+'<div class="row" style="margin-bottom:14px">'+logo()+'<div><div class="brand">Tandem</div><div class="sub">Shared project management</div></div></div>'+
  (window.AndroidBridge&&AndroidBridge.setAppUrl?'<div class="card"><h3>Open your Tandem website</h3><p class="small muted">Enter the address of your Tandem site once (for example <b>tandem-xyz.vercel.app</b>). The app then always loads the newest version from it.</p><label class="f">Website address</label><input class="i" id="appurl" placeholder="tandem-xyz.vercel.app" autocapitalize="off" autocorrect="off"><div class="err" id="aperr"></div><button class="btn" style="width:100%;margin-top:12px" data-a="setAppUrl">Open my Tandem</button></div><div class="ordiv"><span>or connect directly</span></div>':'')+
  '<div class="card"><h3>Connect your Supabase project</h3><p class="small muted">Your data is stored in your own Supabase. Ask the project owner for a <b>connection code</b>, or enter the URL and anon key from Supabase → Project Settings → API.</p>'+
  '<label class="f">Connection code</label><input class="i" id="ccode" placeholder="Paste a code that starts with TANDEM:">'+
  '<div class="hint" style="text-align:center;margin:10px 0">or</div>'+
  '<label class="f">Supabase URL</label><input class="i" id="curl" placeholder="https://xxxx.supabase.co" value="'+esc(conn.url)+'"><label class="f">Anon public key</label><input class="i" id="ckey" placeholder="eyJhbGciOi…" value="'+esc(conn.key)+'">'+
  '<div class="err" id="cerr"></div><button class="btn" style="width:100%;margin-top:12px" data-a="connect">Connect</button></div>'+
  '<div class="card"><h3>Just looking?</h3><p class="small muted">Try Tandem with a sample project. Demo data stays on this device only and isn\'t shared.</p><button class="btn ghost" data-a="demo">Try the demo</button></div></div>';
}
function renderAuth(){
  document.getElementById("tabs").innerHTML="";var m=S.sub.auth||"in";
  document.getElementById("app").innerHTML='<div class="auth"><div class="row" style="margin-bottom:14px">'+logo()+'<div><div class="brand">Tandem</div><div class="sub">'+(DB.kind==="demo"?"Demo mode":"Shared project management")+'</div></div></div><div class="card">'+
  (DB.kind==="demo"?'<h3>Demo mode</h3><p class="small muted">No account needed. Data stays on this device.</p><button class="btn" style="width:100%" data-a="signin">Enter demo</button>':
  (cfg.googleSignIn!==false?'<button class="btn gbtn" data-a="google"><svg viewBox="0 0 48 48" width="20" height="20"><path fill="#FFC107" d="M43.6 20.5H42V20H24v8h11.3C33.7 32.7 29.2 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.3-.1-2.4-.4-3.5z"/><path fill="#FF3D00" d="M6.3 14.7l6.6 4.8C14.7 15.1 19 12 24 12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 16.3 4 9.7 8.3 6.3 14.7z"/><path fill="#4CAF50" d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2C29.2 35.1 26.7 36 24 36c-5.2 0-9.6-3.3-11.3-8l-6.5 5C9.5 39.6 16.2 44 24 44z"/><path fill="#1976D2" d="M43.6 20.5H42V20H24v8h11.3c-.8 2.2-2.2 4.2-4.1 5.6l6.2 5.2C37 39.2 44 34 44 24c0-1.3-.1-2.4-.4-3.5z"/></svg>Continue with Google</button><div class="ordiv"><span>or use email</span></div>':'')+'<div class="seg"><button class="'+(m==="in"?"on":"")+'" data-a="sub" data-k="auth" data-v="in">Sign in</button><button class="'+(m==="up"?"on":"")+'" data-a="sub" data-k="auth" data-v="up">Create account</button></div>'+
  (m==="up"?'<label class="f">Your name</label><input class="i" id="aname" autocomplete="name">':'')+
  '<label class="f">Email</label><input class="i" id="aemail" type="email" autocomplete="email"><label class="f">Password</label><input class="i" id="apw" type="password" autocomplete="'+(m==="up"?"new-password":"current-password")+'" placeholder="'+(m==="up"?"At least 6 characters":"")+'">'+
  '<div class="err" id="aerr"></div><button class="btn" style="width:100%;margin-top:12px" data-a="signin">'+(m==="up"?"Create account":"Sign in")+'</button>'+
  (m==="in"?'<button class="btn ghost small" style="margin-top:8px" data-a="forgot">Forgot password?</button>':''))+
  '</div><div class="row" style="justify-content:center"><button class="btn ghost small" data-a="disconnect">'+(DB.kind==="demo"?"Leave demo":"Change Supabase connection")+'</button></div></div>';
}

/* ================= main render ================= */
function render(){
  if(!S.user)return;
  var p=P();
  var head='<header class="top">'+logo()+'<div class="grow"><select class="i" style="font-weight:700;min-height:38px;padding:6px 10px" data-a="switchProj" aria-label="Project">'+S.projects.map(function(x){return'<option value="'+x.id+'"'+(p&&x.id===p.id?" selected":"")+'>'+esc(x.name)+'</option>'}).join("")+'<option value="__new">+ New project…</option></select>'+
    '<div class="sub row" style="gap:6px;margin-top:3px"><span id="liveDot" class="live'+(S.live?"":" off")+'"><i></i>'+(DB.kind==="demo"?"demo":"live")+'</span>'+(p?'· <span>'+progress()+'% done</span>':'')+'</div></div>'+
    (p?'<button class="avatars" style="background:none;border:0;cursor:pointer;padding:0" data-a="team" aria-label="Team">'+S.members.slice(0,4).map(function(m){return avatar(m.id)}).join("")+'</button>':'')+
    (p?bellBtn():'')+'<button class="iconbtn" data-a="settings" aria-label="Settings">'+IC.gear+'</button><button class="iconbtn" data-a="menu" aria-label="Menu">'+IC.menu+'</button></header>';
  var body;
  if(!p)body='<div class="card hero"><h2>Welcome'+(S.user.name?", "+esc(S.user.name):"")+'</h2><p class="muted">Create your first project, then invite your teammate from the team button at the top.</p><button class="btn" style="background:#fff;color:#16324f" data-a="newProject">Create a project</button></div><div class="card small muted">Waiting to be added to someone else\'s project? Ask the owner to add <b>'+esc(S.user.email)+'</b>, then pull to refresh or reopen the app.</div>';
  else if(!S.d)body='<div class="empty loading">'+logo()+'<div>'+TH().loading+'</div></div>';
  else body=({dash:renderDash,ideas:renderIdeas,board:renderBoard,sprint:renderSprint,plan:renderPlan,coach:renderCoach,guide:renderGuide})[S.tab]();
  var phone=isPhone();
  if(p&&S.d&&phone&&(S.tab==="board"||S.tab==="sprint"))body+='<button class="fab" data-a="editTask" data-v="" aria-label="New task">+</button>';
  var desk=isDesk();
  if(desk){var y0=(document.querySelector(".mainbody")||{}).scrollTop||0;}
  var key=(desk?"D":"M")+S.tab+"|"+(S.sub[S.tab]||"")+"|"+S.cur+"|"+(S.tab==="board"?S.filter+"|"+(S.col||""):"")+(S.tab==="ideas"?"|"+(WB.boardId||""):"")+"|"+theme+"|"+(!!S.d);
  var app=document.getElementById("app");var fresh=key!==S.lastKey;S.lastKey=key;
  var y=window.scrollY;
  app.innerHTML=desk?deskShell(p,body):head+body;
  app.classList.toggle("desk",desk);
  if(!fresh){if(desk){var mb=document.querySelector(".mainbody");if(mb)mb.scrollTop=y0}else window.scrollTo(0,y)}
  if(fresh&&!reducedMotion()){app.classList.remove("anim");void app.offsetWidth;app.classList.add("anim");app.querySelectorAll(".card,.task,.issue,.lrow").forEach(function(el,i){el.style.setProperty("--i",Math.min(i,12))});clearTimeout(S.animT);S.animT=setTimeout(function(){app.classList.remove("anim")},900)}else if(!fresh)app.classList.remove("anim");
  var tabsHtml=TABS.map(function(t){return'<button class="'+(S.tab===t[0]?"on":"")+'" data-a="tab" data-v="'+t[0]+'">'+IC[t[0]]+'<span>'+t[1]+'</span></button>'}).join("");
  var tb=document.getElementById("tabs");if(desk){tb.innerHTML="";tb.setAttribute("data-k","")}else if(tb.getAttribute("data-k")!==S.tab+theme){tb.innerHTML=tabsHtml;tb.setAttribute("data-k",S.tab+theme)}
  if(S.tab==="board"&&p&&S.d){if(phone)wireSwipe();else wireDrag()}
  if(S.tab==="ideas"&&p&&S.d&&WB.boardId)mountWB();
  if(S.focusSearch){var si=document.getElementById("search");if(si){si.focus();var L2=si.value.length;si.setSelectionRange(L2,L2)}S.focusSearch=false}
  annotateTerms(app);
  S.slideDir=null;
}
function deskShell(p,body){var hr=new Date().getHours();var greet=(hr<12?"Good morning":hr<18?"Good afternoon":"Good evening")+(S.user.name?", "+esc(S.user.name.split(" ")[0]):"");
  var tabName=(TABS.filter(function(t){return t[0]===S.tab})[0]||["",""])[1];var b=p&&S.d?myBrief():null;
  var me=member(S.user.id)?avatar(S.user.id):'<span class="av" style="background:'+colorFor(S.user.id)+'">'+esc(initials(S.user.name||S.user.email))+'</span>';
  return'<div class="shell"><aside class="side"><div class="sbrand">'+logo()+'<div><div class="brand">Tandem</div><div class="sub">'+(DB.kind==="demo"?"Demo workspace":"Project hub")+'</div></div></div>'+
  '<div class="slabel">Projects</div><div class="slist">'+S.projects.map(function(x){return'<button class="sitem'+(p&&x.id===p.id?" on":"")+'" data-a="pickProj" data-v="'+x.id+'" title="'+esc(x.name)+'"><span class="pdot" style="background:'+colorFor(x.id)+'"></span><span class="ell">'+esc(x.name)+'</span></button>'}).join("")+'<button class="sitem muted" data-a="newProject"><span class="pdot plus">+</span>New project</button></div>'+
  (p?'<div class="slabel">Views</div><nav class="slist">'+TABS.map(function(t,i){return'<button class="sitem'+(S.tab===t[0]?" on":"")+'" data-a="tab" data-v="'+t[0]+'">'+IC[t[0]]+'<span>'+t[1]+'</span><kbd>'+(i+1)+'</kbd></button>'}).join("")+'</nav>':'')+
  '<div class="sfoot"><div class="slabel" style="margin-top:0">Theme</div><div class="themes">'+Object.keys(THEMES).map(function(k){return'<button class="tmini'+(k===theme?" on":"")+'" data-a="theme" data-v="'+k+'" data-t="'+k+'" title="'+THEMES[k].label+' theme">'+MASCOT[k]+'</button>'}).join("")+'</div>'+
  '<button class="sitem" data-a="settings" style="margin:0 0 6px">'+IC.gear+'<span>Settings</span></button><button class="suser" data-a="menu" title="Account & project menu">'+me+'<span class="ell"><b>'+esc(S.user.name||"")+'</b><br><span class="small muted">'+esc(S.user.email)+'</span></span>'+IC.menu+'</button><div class="kbdhint"><kbd>N</kbd> new task · <kbd>/</kbd> search · <kbd>1–7</kbd> views</div></div></aside>'+
  '<main class="main"><header class="dtop"><div class="grow"><div class="crumb">'+(p?esc(tabName):"Welcome")+'</div><h1>'+(p?esc(p.name):"Tandem")+'</h1><div class="sub row" style="gap:8px"><span id="liveDot" class="live'+(S.live?"":" off")+'"><i></i>'+(DB.kind==="demo"?"demo":"live")+'</span>'+(p&&S.d?'<span>· '+progress()+'% done</span><span>· '+greet+'</span>'+(b&&!b.posted?'<a href="#" data-a="goto" data-v="sprint" data-s="standup">· Post today\'s standup</a>':''):'')+'</div></div>'+
  (p?'<button class="avatars" style="background:none;border:0;cursor:pointer;padding:0" data-a="team" title="Team">'+S.members.slice(0,5).map(function(m){return avatar(m.id)}).join("")+'</button><button class="btn ghost" data-a="team">Invite</button>'+bellBtn()+'<button class="btn" data-a="editTask" data-v="">+ New task</button>':'')+'</header>'+
  '<div class="mainbody'+(S.tab==="board"&&p&&S.d?" boardview":"")+(S.tab==="ideas"&&p&&S.d&&WB.boardId?" ideasview":"")+'"><div class="'+(S.tab==="board"?"boardwrap":S.tab==="ideas"&&WB.boardId?"ideaswrap":"viewwrap"+(S.tab==="dash"||S.tab==="ideas"?" wide":""))+'">'+body+'</div></div></main></div>'}
function wireSwipe(){var b=document.getElementById("board");if(!b)return;var x0=null,y0=null;
  b.addEventListener("touchstart",function(e){x0=e.touches[0].clientX;y0=e.touches[0].clientY},{passive:true});
  b.addEventListener("touchend",function(e){if(x0==null)return;var dx=e.changedTouches[0].clientX-x0,dy=e.changedTouches[0].clientY-y0;x0=null;if(Math.abs(dx)<60||Math.abs(dx)<Math.abs(dy)*1.5)return;var i=COLS.indexOf(S.col||"To Do")+(dx<0?1:-1);if(i<0||i>=COLS.length)return;S.slideDir=dx<0?"L":"R";S.col=COLS[i];buzz(8);render()},{passive:true})}

/* ---------- Board ---------- */
function renderBoard(){
  var p=P(),sp=activeSprint(),f=S.filter;if(f==="sprint"&&!sp)f="all";var cp=critPath(),phone=isPhone();
  var q=(S.q||"").toLowerCase();var desk=isDesk();
  var tasks=D().tasks.filter(function(t){return(f==="all"||(f==="mine"&&t.assignee===S.user.id)||(f==="none"&&!t.assignee)||(f.indexOf("u:")===0&&t.assignee===f.slice(2))||(f==="sprint"&&sp&&t.sprint_id===sp.id))&&(!q||(t.title+" "+(t.description||"")).toLowerCase().indexOf(q)>=0)});
  var ipAll=D().tasks.filter(function(t){return t.status==="In Progress"}).length;
  var h='<div class="row between boardbar"><div class="chips"><button class="chip'+(f==="all"?" on":"")+'" data-a="bfilter" data-v="all">All</button><button class="chip'+(f==="mine"?" on":"")+'" data-a="bfilter" data-v="mine">Mine</button>'+S.members.filter(function(m){return m.id!==S.user.id}).map(function(m){return'<button class="chip pchip'+(f==="u:"+m.id?" on":"")+'" data-a="bfilter" data-v="u:'+m.id+'">'+avatar(m.id,1)+esc(m.name.split(" ")[0])+'</button>'}).join("")+'<button class="chip'+(f==="none"?" on":"")+'" data-a="bfilter" data-v="none">Unassigned</button>'+(sp?'<button class="chip'+(f==="sprint"?" on":"")+'" data-a="bfilter" data-v="sprint">'+esc(sp.name)+'</button>':'')+'</div>'+(desk?'<label class="searchbox">'+IC.search+'<input id="search" placeholder="Search tasks  ( / )" value="'+esc(S.q||"")+'"></label>':'')+
  '<div class="row small muted">WIP <select class="i wipsel" data-a="wip">'+[1,2,3,4,5,6,8,10].map(function(n){return'<option'+(n===p.wip_limit?" selected":"")+'>'+n+'</option>'}).join("")+'</select>'+(phone||desk?'':'<button class="btn small" data-a="editTask" data-v="">+ Task</button>')+'</div></div>';
  if(isDesk())h=kpiStrip()+h;else h=briefCard()+h;
  var curCol=S.col||"To Do";
  if(phone)h+='<div class="colnav" role="tablist">'+COLS.map(function(c){var n=tasks.filter(function(t){return t.status===c}).length;return'<button role="tab" class="'+(c===curCol?"on":"")+(c==="In Progress"&&ipAll>p.wip_limit?" bad":"")+'" data-a="col" data-v="'+c+'">'+c+'<span class="n">'+n+'</span></button>'}).join("")+'</div>';
  var cols=phone?[curCol]:COLS;
  h+='<div class="board'+(phone?" single":"")+'" id="board">'+cols.map(function(c){var ci=COLS.indexOf(c);var ts=tasks.filter(function(t){return t.status===c});
    if(c==="Done")ts.sort(function(a,b){return(b.done_at||"").localeCompare(a.done_at||"")});else ts.sort(function(a,b){return PRI.indexOf(a.priority||"Wont")-PRI.indexOf(b.priority||"Wont")||(a.due||"9").localeCompare(b.due||"9")});
    var pts=ts.reduce(function(a,t){return a+(+t.points||0)},0);var over=c==="In Progress"&&ipAll>p.wip_limit;
    return'<div class="col'+(phone&&S.slideDir?" slide"+S.slideDir:"")+'" data-col="'+c+'"><div class="colh"><span>'+c+'</span><span class="cnt'+(over?" bad":"")+'">'+ts.length+(c==="In Progress"?" · WIP "+ipAll+"/"+p.wip_limit:"")+' · '+pts+' pts</span></div>'+
    (!desk&&(ci===0||phone)&&c!=="Done"?'<div class="quick"><input class="i" id="quickAdd" placeholder="Quick add to '+c+'… (verb first)" enterkeyhint="done"><button class="btn small" data-a="quickAdd" data-v="'+c+'">Add</button></div>':'')+
    (over?'<div class="tip badbox small">Over the WIP limit. Finish or review something before starting more.</div>':'')+
    '<div class="colbody">'+ts.map(function(t){return taskCard(t,cp,ci,phone)}).join("")+(ts.length?'':'<div class="empty small colempty">'+((theme!=="classic"&&theme!=="pro")?'<div class="mini">'+MASCOT[theme]+'</div>':'')+TH().empty+'</div>')+(desk&&c!=="Done"?'<button class="coladd" data-a="addIn" data-v="'+c+'">+ Add task</button>':'')+'</div></div>'}).join("")+'</div>';
  if(desk)return h;
  h+=phone?'<div class="small muted swipehint">Swipe ← → to switch columns · tap a card for details</div>':'<div class="small muted" style="margin-top:6px">Orange edge = critical path · Red edge = blocked · Tap a card for details & comments</div>';
  return h;
}
function taskCard(t,cp,ci,phone){var bl=isBlocked(t),od=isOverdue(t);var pop=S.justMoved===t.id;
  var prev=ci>0?'<button class="mvb" data-a="move" data-v="'+t.id+'" data-d="-1" aria-label="Move back to '+COLS[ci-1]+'">◀</button>':'<span class="mvb ghosted"></span>';
  var next=ci<COLS.length-1?(phone?'<button class="mvb nextb" data-a="move" data-v="'+t.id+'" data-d="1">'+COLS[ci+1]+' ▶</button>':'<button class="mvb" data-a="move" data-v="'+t.id+'" data-d="1" aria-label="Move to '+COLS[ci+1]+'">▶</button>'):'<span class="mvb ghosted"></span>';
  return'<div class="task'+(bl?" blocked":cp[t.id]?" crit":"")+(pop?" pop"+(t.status==="Done"?" glow":""):"")+'"'+(phone?'':' draggable="true"')+' data-id="'+t.id+'" data-a="editTask" data-v="'+t.id+'"><div class="t">'+(t.status==="Done"?'<span class="donecheck">✓</span> ':'')+esc(t.title)+'</div><div class="meta">'+(t.priority?'<span class="pill p-'+t.priority+'">'+PRILABEL[t.priority]+'</span>':'')+(t.points?'<span class="pill">'+t.points+' pts</span>':'')+(t.due?'<span class="'+(od?"overdue":"")+'">📅 '+fmtDate(t.due)+'</span>':'')+(bl?'<span class="overdue">⛔ blocked</span>':'')+(commentCount(t.id)?'<span>💬 '+commentCount(t.id)+'</span>':'')+'</div>'+
  '<div class="mv">'+prev+('<button class="achip'+(t.assignee?"":" none")+'" data-a="quickAssign" data-v="'+t.id+'" title="'+(t.assignee?"Assigned to "+esc(mname(t.assignee))+" · tap to change":"Assign someone")+'">'+(t.assignee?avatar(t.assignee,1)+'<span class="an">'+esc((mname(t.assignee)||"").split(" ")[0])+'</span>':'<span class="av sm" style="background:transparent;border:1.5px dashed var(--muted);color:var(--muted)">+</span><span class="an">Assign</span>')+'</button>')+next+'</div></div>'}
function wireDrag(){var dragId=null;document.querySelectorAll(".task").forEach(function(el){el.addEventListener("dragstart",function(e){dragId=el.dataset.id;try{e.dataTransfer.setData("text/plain",dragId)}catch(x){}})});
  document.querySelectorAll(".col").forEach(function(col){col.addEventListener("dragover",function(e){e.preventDefault();col.classList.add("over")});col.addEventListener("dragleave",function(){col.classList.remove("over")});col.addEventListener("drop",function(e){e.preventDefault();col.classList.remove("over");if(dragId)setStatus(dragId,col.dataset.col)})})}
function setStatus(id,status){var p=P(),t=taskById(id);if(!t||t.status===status)return;var tip=null;
  if(status==="In Progress"){var ip=D().tasks.filter(function(x){return x.status==="In Progress"}).length;if(ip>=p.wip_limit)tip="Heads up: that's over the WIP limit of "+p.wip_limit+".";else if(isBlocked(t))tip="This task is blocked by an unfinished dependency.";else if(!t.assignee)tip="Tip: assign an owner before starting."}
  if(status==="Done"&&t.status!=="Review"&&(t.acceptance||"").trim())tip="Tip: send it through Review so someone checks the acceptance criteria.";
  var from=COLS.indexOf(t.status),to=COLS.indexOf(status);
  t.status=status;t.done_at=status==="Done"?today():null;S.justMoved=id;buzz(status==="Done"?[12,40,20]:10);
  var el=document.querySelector('.task[data-id="'+id+'"]');var phone=isPhone();
  var go=function(){render();S.justMoved=null;if(tip)toast(tip);else if(status==="Done")toast(TH().done);else if(phone)toast("Moved to "+status)};
  if(el&&phone&&!reducedMotion()){el.classList.add(to>from?"outR":"outL");setTimeout(go,180)}else go();
  act(function(){return DB.upd("tasks",id,{status:status,done_at:status==="Done"?today():null})})}
function editTask(id){
  var p=P();var t=id?taskById(id):{title:"",description:"",acceptance:"",status:S.newStatus||"To Do",priority:"",points:"",assignee:S.user.id,due:"",deps:[],sprint_id:(activeSprint()||{}).id||null};
  if(id&&!t)return;openTaskId=id||null;
  var others=D().tasks.filter(function(x){return x.id!==id&&x.status!=="Done"});
  modal('<div class="mh"><h3>'+(id?"Task":"New task")+'</h3><button class="x" data-a="close" aria-label="Close">×</button></div>'+
  '<label class="f">Title</label><input class="i" id="tt" value="'+esc(t.title)+'" placeholder="Start with a verb: Draft topic list…">'+
  '<div class="grid2"><div><label class="f">Status</label><select class="i" id="ts">'+COLS.map(function(c){return'<option'+(c===t.status?" selected":"")+'>'+c+'</option>'}).join("")+'</select></div>'+
  '<div><label class="f">Assignee</label><select class="i" id="ta"><option value="">Unassigned</option>'+S.members.map(function(m){return'<option value="'+m.id+'"'+(m.id===t.assignee?" selected":"")+'>'+esc(m.name)+(m.id===S.user.id?" (me)":"")+'</option>'}).join("")+'</select></div>'+
  '<div><label class="f">Priority (MoSCoW)</label><select class="i" id="tp"><option value="">-</option>'+PRI.map(function(x){return'<option value="'+x+'"'+(x===t.priority?" selected":"")+'>'+PRILABEL[x]+'</option>'}).join("")+'</select></div>'+
  '<div><label class="f">Story points</label><select class="i" id="te"><option value="">-</option>'+POINTS.map(function(x){return'<option'+(String(x)===String(t.points)?" selected":"")+'>'+x+'</option>'}).join("")+'</select></div>'+
  '<div><label class="f">Due date</label><input class="i" type="date" id="td" value="'+esc(t.due||"")+'"></div>'+
  '<div><label class="f">Sprint</label><select class="i" id="tsp"><option value="">None (backlog)</option>'+D().sprints.filter(function(s){return s.status!=="Closed"||s.id===t.sprint_id}).map(function(s){return'<option value="'+s.id+'"'+(s.id===t.sprint_id?" selected":"")+'>'+esc(s.name)+'</option>'}).join("")+'</select></div></div>'+
  '<div class="hint" id="pthint"></div>'+
  '<label class="f">Description</label><textarea class="i" id="tdesc" placeholder="Context, links, notes">'+esc(t.description)+'</textarea>'+
  '<label class="f">Acceptance criteria (definition of done)</label><textarea class="i" id="tac" placeholder="One check per line">'+esc(t.acceptance)+'</textarea>'+
  '<label class="f">Blocked by (must finish first)</label><div class="chips">'+(others.length?others.map(function(o){return'<button type="button" class="chip'+((t.deps||[]).indexOf(o.id)>=0?" on":"")+'" data-dep="'+o.id+'">'+esc(o.title)+'</button>'}).join(""):'<span class="muted small">No other open tasks.</span>')+'</div>'+
  '<div class="row between sheet-actions" style="margin-top:14px">'+(id?'<button class="btn danger small" id="tdel">Delete</button>':'<span></span>')+'<div class="row"><button class="btn ghost" data-a="close">Cancel</button><button class="btn" id="tsave">Save</button></div></div>'+
  (id?'<h3 style="margin-top:18px">Comments</h3><div id="cmts"><div class="small muted">Loading…</div></div><div class="cform">'+rtEditorHTML("cbody","","Write a comment… type @ to tag someone")+'<div class="row between" style="margin-top:6px"><span class="small muted">Ctrl/⌘ + Enter to send</span><button class="btn small" id="csend">Send</button></div></div>'+'<div class="hint">Created '+(t.created_at?ago(t.created_at):"")+(t.created_by&&member(t.created_by)?" by "+esc(mname(t.created_by)):"")+'</div>':''),
  function(m){
    m.querySelectorAll("[data-dep]").forEach(function(b){b.onclick=function(e){e.stopPropagation();b.classList.toggle("on")}});
    var pe=m.querySelector("#te"),ph=m.querySelector("#pthint");pe.onchange=function(){ph.textContent=+pe.value>=13?"13+ points: consider splitting this into smaller tasks.":""};pe.onchange();
    m.querySelector("#tsave").onclick=async function(){var title=m.querySelector("#tt").value.trim();if(!title){toast("Give the task a title");return}
      var st=m.querySelector("#ts").value;
      var row={title:title,status:st,priority:m.querySelector("#tp").value||null,points:m.querySelector("#te").value?+m.querySelector("#te").value:null,assignee:m.querySelector("#ta").value||null,due:m.querySelector("#td").value||null,sprint_id:m.querySelector("#tsp").value||null,description:m.querySelector("#tdesc").value,acceptance:m.querySelector("#tac").value,deps:[].map.call(m.querySelectorAll("[data-dep].on"),function(b){return b.dataset.dep})};
      if(st==="Done"&&(!id||t.status!=="Done"))row.done_at=today();if(st!=="Done")row.done_at=null;
      closeModal();
      if(id)await act(function(){return DB.upd("tasks",id,row)});else{row.project_id=p.id;await act(function(){return DB.ins("tasks",row)},"Task added")}};
    var del=m.querySelector("#tdel");if(del)del.onclick=function(){confirmBox("Delete “"+t.title+"”? Comments go with it.",function(){act(async function(){await DB.del("tasks",id);var dep=D().tasks.filter(function(x){return(x.deps||[]).indexOf(id)>=0});for(var i=0;i<dep.length;i++)await DB.upd("tasks",dep[i].id,{deps:dep[i].deps.filter(function(d){return d!==id})})},"Deleted")},"Delete")};
    if(id){renderComments(id);var rt;var send=async function(){if(rtIsEmpty(rt.el))return;var html=rt.get(),men=rtMentions(html).filter(function(u){return u!==S.user.id});rt.clear();try{await DB.addComment(p.id,id,html,S.user.id,men);renderComments(id);if(men.length)toast("Sent · "+men.map(mname).join(", ")+" will be notified");if(S.noMentionCol&&men.length)toast("Sent. Tag notifications need the latest database update.")}catch(e){toast("⚠ "+e.message)}};rt=rtWire(m.querySelector(".cform .rte"),send);m.querySelector("#csend").onclick=send}
    else m.querySelector("#tt").focus();
  },{drawer:true});S.newStatus=null;
}
async function renderComments(id){var box=document.getElementById("cmts");if(!box)return;try{var cs=await DB.comments(id);box=document.getElementById("cmts");if(!box)return;S.cmtCache=cs;
  box.innerHTML=cs.length?cs.map(function(c){var mine=c.user_id===S.user.id;var tagged=(c.mentions||[]).indexOf(S.user.id)>=0;return'<div class="comment'+(tagged?" tagged":"")+'" data-cid="'+c.id+'"><div class="row" style="gap:6px">'+avatar(c.user_id,1)+'<span class="who">'+esc(mname(c.user_id)||"Someone")+'</span><span class="small muted">'+ago(c.created_at)+(c.edited_at?' · edited':'')+'</span>'+(mine?'<span class="cact"><button class="linkbtn" data-a="cEdit" data-v="'+c.id+'">Edit</button><button class="linkbtn" data-a="cDel" data-v="'+c.id+'">Delete</button></span>':'')+'</div><div class="cbody rtview">'+rtRender(c.body)+'</div></div>'}).join(""):'<div class="small muted">No comments yet. Ask questions here instead of in chat, and type @ to tag a teammate.</div>'}catch(e){box.innerHTML='<div class="err">'+esc(e.message)+'</div>'}}

/* ---------- Sprint ---------- */
function renderSprint(){
  var sub=S.sub.sprint||"plan";var h=subtabs("sprint",[["plan","Sprint"],["standup","Standups"],["retro","Retros"],["velocity","Velocity"]],"plan");
  if(sub==="plan"){var sp=activeSprint();
    if(sp){var st=D().tasks.filter(function(t){return t.sprint_id===sp.id});var tot=st.reduce(function(a,t){return a+(+t.points||0)},0),dn=st.filter(function(t){return t.status==="Done"}).reduce(function(a,t){return a+(+t.points||0)},0);
      var days=Math.max(1,Math.round((new Date(sp.end_date)-new Date(sp.start_date))/864e5)+1),el=Math.min(days,Math.max(0,Math.round((new Date(today())-new Date(sp.start_date))/864e5)+1));var ideal=Math.round(tot*(1-el/days));
      h+='<div class="dgrid">';h+='<div class="card"><div class="row between"><h3 style="margin:0">'+esc(sp.name)+' <span class="pill p-Could">Active</span></h3><span class="small muted">'+fmtDate(sp.start_date)+' → '+fmtDate(sp.end_date)+'</span></div><p><b>Sprint goal:</b> '+(sp.goal?esc(sp.goal):'<span class="overdue">No goal yet. Add one sentence on why this sprint matters.</span>')+'</p>'+ceremonyLine(sp)+
      '<div class="small muted">'+dn+' of '+tot+' pts done · day '+el+' of '+days+'</div><div class="bar" style="margin:6px 0"><i style="width:'+(tot?dn/tot*100:0)+'%"></i></div>'+
      '<div class="tip small '+(tot-dn<=ideal?"ok":"warnbox")+'">'+(tot-dn<=ideal?'<b>On pace.</b> '+(tot-dn)+' pts left vs. '+ideal+' on the ideal burndown line.':'<b>Behind pace.</b> '+(tot-dn)+' pts left vs. '+ideal+' ideal. Raise it at standup; consider dropping a Could.')+'</div>'+
      '<h3>Sprint backlog</h3>'+(st.length?st.map(function(t){return'<div class="lrow"><div class="grow" data-a="editTask" data-v="'+t.id+'" style="cursor:pointer"><div class="lt">'+(t.status==="Done"?'<span class="donecheck">✓</span> ':'')+esc(t.title)+'</div><div class="meta row" style="gap:6px">'+(t.assignee?avatar(t.assignee,1):'')+'<span class="pill">'+(t.points||"?")+' pts</span><span class="pill st-'+t.status.replace(/ /g,"")+'">'+t.status+'</span></div></div><button class="iconbtn sm" data-a="unsprint" data-v="'+t.id+'" aria-label="Remove from sprint">−</button></div>'}).join(""):'<p class="muted small">Nothing in this sprint yet. Add from the backlog below.</p>')+
      '<div class="row" style="margin-top:10px"><button class="btn ghost small" data-a="editSprint" data-v="'+sp.id+'">Edit sprint</button><button class="btn small" data-a="closeSprint" data-v="'+sp.id+'">Close sprint</button></div></div>';
      var avail=D().tasks.filter(function(t){return!t.sprint_id&&t.status!=="Done"}).sort(function(a,b){return PRI.indexOf(a.priority||"Wont")-PRI.indexOf(b.priority||"Wont")});var v=velocity();
      h+='<div class="card"><h3>Backlog → sprint</h3><p class="small muted">'+(v?'Average velocity: <b>'+v+' pts</b>. Planned: <b>'+tot+' pts</b>. ':'')+'Pick what serves the sprint goal, Musts first.</p>'+(avail.length?avail.map(function(t){return'<div class="row between" style="padding:6px 0;border-bottom:1px solid var(--line)"><span>'+esc(t.title)+' '+(t.priority?'<span class="pill p-'+t.priority+'">'+PRILABEL[t.priority]+'</span>':'')+' <span class="pill">'+(t.points||"?")+' pts</span></span><button class="btn small" data-a="tosprint" data-v="'+t.id+'">Add</button></div>'}).join(""):'<p class="muted small">Backlog is empty.</p>')+'</div>';h+='</div>';h+='<div class="card"><h3>Burndown</h3>'+burndownSVG(sp)+'</div>';
    }else h+='<div class="card empty"><p>No active sprint.</p><p class="small">A sprint is a 1–2 week box of work with one shared goal.</p><button class="btn" data-a="editSprint" data-v="">Plan a sprint</button></div>';
    var closed=D().sprints.filter(function(s){return s.status==="Closed"}).reverse();
    if(closed.length)h+='<div class="card"><h3>Past sprints</h3>'+closed.map(function(s){return'<div class="small" style="padding:4px 0"><b>'+esc(s.name)+'</b> · '+(s.velocity||0)+' pts · '+esc(s.goal)+'</div>'}).join("")+'</div>';
  }
  if(sub==="standup"){
    var mine=D().standups.filter(function(s){return s.user_id===S.user.id&&s.day===today()})[0];
    h+='<div class="card"><h3>'+(mine?"Update today\'s standup":"Today\'s standup")+'</h3><p class="small muted">2 minutes. The point is to surface blockers early.</p><label class="f">Yesterday I finished…</label><textarea class="i" id="su1">'+esc(mine?mine.yesterday:"")+'</textarea><label class="f">Today I will…</label><textarea class="i" id="su2">'+esc(mine?mine.today:"")+'</textarea><label class="f">Blockers</label><textarea class="i" id="su3" placeholder="Leave empty if none">'+esc(mine?mine.blockers:"")+'</textarea><button class="btn" style="margin-top:10px" data-a="saveStandup" data-v="'+(mine?mine.id:"")+'">'+(mine?"Update":"Post standup")+'</button></div>';
    var byDay={};D().standups.forEach(function(s){(byDay[s.day]=byDay[s.day]||[]).push(s)});
    Object.keys(byDay).sort().reverse().slice(0,14).forEach(function(d){h+='<div class="card small"><b>'+(d===today()?"Today":fmtDate(d))+'</b>'+byDay[d].map(function(s){return'<div style="margin-top:8px"><div class="row" style="gap:6px">'+avatar(s.user_id,1)+'<b>'+esc(mname(s.user_id))+'</b></div>'+(s.yesterday?'<div><span class="muted">Done:</span> '+esc(s.yesterday)+'</div>':'')+(s.today?'<div><span class="muted">Today:</span> '+esc(s.today)+'</div>':'')+(s.blockers?'<div class="overdue">⛔ '+esc(s.blockers)+'</div>':'')+'</div>'}).join("")+'</div>'});
  }
  if(sub==="retro"){
    h+='<div class="card"><h3>New retrospective</h3><p class="small muted">Blameless: focus on the process, not people. Rotate formats.</p><div class="row"><button class="btn small" data-a="newRetro" data-v="ssc">Start · Stop · Continue</button><button class="btn small" data-a="newRetro" data-v="4l">4Ls</button><button class="btn small" data-a="newRetro" data-v="msg">Mad · Sad · Glad</button></div></div>';
    D().retros.slice().reverse().forEach(function(r){var d=r.data||{cols:[],actions:[]};h+='<div class="card"><div class="row between"><h3 style="margin:0">'+esc(r.title)+'</h3><span class="small muted">'+fmtDate(r.created_at)+'</span></div><div class="retro3" style="margin-top:10px">'+d.cols.map(function(c,ci){return'<div class="box"><h4>'+esc(c.name)+'</h4>'+c.notes.map(function(n,ni){return'<div class="note"><span>'+esc(typeof n==="string"?n:n.text)+'</span><button data-a="delNote" data-r="'+r.id+'" data-c="'+ci+'" data-n="'+ni+'" aria-label="Remove">×</button></div>'}).join("")+'<div class="quick" style="margin:6px 0 0"><input class="i" style="min-height:34px;padding:5px 8px" id="rn-'+r.id+'-'+ci+'" placeholder="Add a note"><button class="btn small" data-a="addNote" data-r="'+r.id+'" data-c="'+ci+'">+</button></div></div>'}).join("")+'</div>'+
      '<h4 style="margin:14px 0 6px">Action items</h4>'+(d.actions.length?d.actions.map(function(a,ai){return'<div class="note" style="background:var(--surface2)"><label class="row" style="gap:6px"><input type="checkbox" data-a="toggleAct" data-r="'+r.id+'" data-n="'+ai+'"'+(a.done?" checked":"")+'> <span'+(a.done?' style="text-decoration:line-through"':'')+'>'+esc(a.text)+' <span class="muted">· '+esc(a.owner||"no owner")+'</span></span></label></div>'}).join(""):'<p class="small muted">No actions yet. A retro without actions changes nothing.</p>')+
      '<div class="row" style="margin-top:6px"><input class="i" style="flex:2;min-width:140px" id="ra-'+r.id+'" placeholder="Action"><select class="i" style="flex:1;min-width:100px" id="ro-'+r.id+'"><option value="">Owner…</option>'+S.members.map(function(m){return'<option>'+esc(m.name)+'</option>'}).join("")+'</select><button class="btn small" data-a="addAct" data-r="'+r.id+'">Add</button></div></div>'});
  }
  if(sub==="velocity"){var cs=D().sprints.filter(function(s){return s.status==="Closed"});var mx=Math.max.apply(null,cs.map(function(s){return s.velocity||0}).concat([1]));
    h+='<div class="card"><h3>Velocity</h3><p class="small muted">Points finished per closed sprint. Plan the next sprint near the average of the last 3.</p>'+(cs.length?'<div class="chart">'+cs.slice(-8).map(function(s){return'<div class="b"><span>'+(s.velocity||0)+'</span><i style="height:'+((s.velocity||0)/mx*80)+'%"></i><span>'+esc(s.name.replace(/^Sprint\s*/i,"S"))+'</span></div>'}).join("")+'</div><p style="margin-top:10px"><b>Average (last 3):</b> '+velocity()+' pts</p>':'<div class="empty">Close your first sprint to see velocity.</div>')+'</div>';
  }
  return h;
}
function dtl(v,fb){v=v||fb||"";return String(v).slice(0,16)}
function fmtDT(v){if(!v)return"";var d=new Date(v);return d.toLocaleDateString(undefined,{weekday:"short",month:"short",day:"numeric"})+" · "+d.toLocaleTimeString(undefined,{hour:"numeric",minute:"2-digit"})}
function editSprint(id){var p=P();var n=D().sprints.length+1;var s=id?D().sprints.filter(function(x){return x.id===id})[0]:{name:"Sprint "+n,goal:"",start_date:today(),end_date:addDays(13)};
  modal('<div class="mh"><h3>'+(id?"Edit sprint":"Plan a sprint")+'</h3><button class="x" data-a="close">×</button></div><label class="f">Name</label><input class="i" id="sn" value="'+esc(s.name)+'"><label class="f">Sprint goal</label><textarea class="i" id="sg" placeholder="One sentence: what\'s true at the end of this sprint?">'+esc(s.goal)+'</textarea><div class="grid2"><div><label class="f">Start</label><input class="i" type="date" id="ss" value="'+s.start_date+'"></div><div><label class="f">End</label><input class="i" type="date" id="se" value="'+s.end_date+'"></div></div><div class="hint">1–2 weeks works best for a small team.</div>'+
  '<h4 style="margin:14px 0 2px">Ceremonies</h4><div class="grid2"><div><label class="f">🗓 Sprint planning</label><input class="i" type="datetime-local" id="spl" value="'+dtl(s.planning_at,s.start_date+"T10:00")+'"></div><div><label class="f">🔁 Retrospective</label><input class="i" type="datetime-local" id="srt" value="'+dtl(s.retro_at,s.end_date+"T16:00")+'"></div></div><div class="hint">Planning opens the sprint; review + retro close it. They show on the Dashboard timeline.</div>'+
  '<div class="row sheet-actions" style="justify-content:flex-end;margin-top:14px"><button class="btn ghost" data-a="close">Cancel</button><button class="btn" id="ssave">Save</button></div>',
  function(m){var ss=m.querySelector("#ss"),se=m.querySelector("#se"),pl=m.querySelector("#spl"),rt=m.querySelector("#srt");
   ss.onchange=function(){if(!id)pl.value=ss.value+"T10:00"};se.onchange=function(){if(!id)rt.value=se.value+"T16:00"};
   m.querySelector("#ssave").onclick=function(){var row={name:m.querySelector("#sn").value.trim()||"Sprint "+n,goal:m.querySelector("#sg").value.trim(),start_date:ss.value,end_date:se.value,planning_at:pl.value?new Date(pl.value).toISOString():null,retro_at:rt.value?new Date(rt.value).toISOString():null};if(!row.start_date||!row.end_date||row.end_date<row.start_date){toast("Check the dates");return}closeModal();
    if(id)act(function(){return DB.upd("sprints",id,row)});else{row.project_id=p.id;row.status="Active";act(function(){return DB.ins("sprints",row)},"Sprint started")}}},{drawer:true})}

/* ---------- Dashboard & charts ---------- */
function sprintTasks(sp){return D().tasks.filter(function(t){return t.sprint_id===sp.id})}
function dayList(a,b){var out=[],d=new Date(a+"T00:00:00"),e=new Date(b+"T00:00:00");while(d<=e&&out.length<120){out.push(ymd(d));d.setDate(d.getDate()+1)}return out}
function ceremonyLine(sp){var td=today();var pl=sp.planning_at,rt=sp.retro_at;var left=Math.round((new Date(sp.end_date+"T00:00:00")-new Date(td+"T00:00:00"))/864e5);
  return'<div class="ceremonies"><span class="cer'+(pl&&pl.slice(0,10)<=td?" done":"")+'">🗓 Planning <b>'+(pl?fmtDT(pl):fmtDate(sp.start_date))+'</b></span><span class="cer'+(rt&&rt.slice(0,10)<td?" done":"")+'">🔁 Retro <b>'+(rt?fmtDT(rt):fmtDate(sp.end_date))+'</b></span><span class="cer">'+(left>0?left+" day"+(left>1?"s":"")+" left":left===0?"Last day":"Ended")+'</span></div>'}
function burndownSVG(sp){
  var days=dayList(sp.start_date,sp.end_date);if(days.length<2)return'<div class="empty small">Sprint needs at least 2 days.</div>';
  var st=sprintTasks(sp),tot=st.reduce(function(a,t){return a+(+t.points||0)},0);if(!tot)return'<div class="empty small">Add estimated tasks to this sprint to see the burndown.</div>';
  var td=today(),W=640,H=230,L=40,R=16,T=18,B=34,iw=W-L-R,ih=H-T-B,n=days.length-1;
  var x=function(i){return L+iw*i/n},y=function(v){return T+ih*(1-v/tot)};
  var actual=[];days.forEach(function(d,i){if(d>td)return;var done=st.filter(function(t){return t.status==="Done"&&t.done_at&&t.done_at<=d}).reduce(function(a,t){return a+(+t.points||0)},0);actual.push([i,tot-done,d])});
  var g='';for(var k=0;k<=4;k++){var v=tot*k/4,yy=y(v);g+='<line x1="'+L+'" x2="'+(W-R)+'" y1="'+yy+'" y2="'+yy+'" class="grid"/><text x="'+(L-8)+'" y="'+(yy+4)+'" class="ax" text-anchor="end">'+Math.round(v)+'</text>'}
  var lab=[0,Math.floor(n/2),n].map(function(i){return'<text x="'+x(i)+'" y="'+(H-12)+'" class="ax" text-anchor="'+(i===0?"start":i===n?"end":"middle")+'">'+fmtDate(days[i])+'</text>'}).join("");
  var ideal='<line x1="'+x(0)+'" y1="'+y(tot)+'" x2="'+x(n)+'" y2="'+y(0)+'" class="ideal"/>';
  var path=actual.map(function(p,i){return(i?"L":"M")+x(p[0]).toFixed(1)+" "+y(p[1]).toFixed(1)}).join(" ");
  var area=actual.length?'<path d="'+path+' L'+x(actual[actual.length-1][0]).toFixed(1)+' '+y(0)+' L'+x(0)+' '+y(0)+'Z" class="area"/>':'';
  var dots=actual.map(function(p,i){var last=i===actual.length-1;return'<g class="pt"><circle cx="'+x(p[0])+'" cy="'+y(p[1])+'" r="'+(last?5:3.2)+'" class="dot'+(last?" last":"")+'"/><circle cx="'+x(p[0])+'" cy="'+y(p[1])+'" r="12" class="hit"><title>'+fmtDate(p[2])+': '+p[1]+' pts remaining (ideal '+Math.round(tot*(1-p[0]/n))+')</title></circle></g>'}).join("");
  var ti=days.indexOf(td),tm=ti>=0?'<line x1="'+x(ti)+'" x2="'+x(ti)+'" y1="'+T+'" y2="'+(T+ih)+'" class="today"/><text x="'+x(ti)+'" y="'+(T-5)+'" class="ax tlab" text-anchor="middle">Today</text>':'';
  var flag=function(iso,lbl){if(!iso)return"";var i=days.indexOf(iso.slice(0,10));if(i<0)return"";return'<g class="flag"><line x1="'+x(i)+'" x2="'+x(i)+'" y1="'+(T+ih)+'" y2="'+(T+ih-14)+'"/><text x="'+(x(i)+(i===n?-4:4))+'" y="'+(T+ih-17)+'" text-anchor="'+(i===n?"end":"start")+'" class="ax">'+lbl+'</text></g>'};
  var last=actual[actual.length-1],idealNow=last?Math.round(tot*(1-last[0]/n)):tot,status=last?(last[1]<=idealNow?'<span class="pill st-Done">On pace</span>':'<span class="pill st-Review">Behind by '+(last[1]-idealNow)+' pts</span>'):'';
  return'<div class="legend"><span><i class="sw act"></i>Remaining</span><span><i class="sw idl"></i>Ideal</span>'+status+'</div><svg class="chart-svg burn" viewBox="0 0 '+W+' '+H+'" role="img" aria-label="Burndown: '+(last?last[1]:tot)+' of '+tot+' points remaining">'+g+lab+flag(sp.planning_at,"Planning")+flag(sp.retro_at,"Retro")+tm+ideal+area+'<path d="'+path+'" class="actual"/>'+dots+'</svg>'}
function velocitySVG(){var cs=D().sprints.filter(function(s){return s.status==="Closed"}).slice(-8);if(!cs.length)return'<div class="empty small">Close your first sprint to see velocity.</div>';
  var W=420,H=200,L=34,R=10,T=16,B=30,iw=W-L-R,ih=H-T-B,mx=Math.max.apply(null,cs.map(function(s){return s.velocity||0}).concat([5]));mx=Math.ceil(mx*1.15);
  var bw=Math.min(46,iw/cs.length-12),avg=velocity();var out='';
  for(var k=0;k<=3;k++){var v=mx*k/3,yy=T+ih*(1-v/mx);out+='<line x1="'+L+'" x2="'+(W-R)+'" y1="'+yy+'" y2="'+yy+'" class="grid"/><text x="'+(L-6)+'" y="'+(yy+4)+'" class="ax" text-anchor="end">'+Math.round(v)+'</text>'}
  cs.forEach(function(s,i){var cx=L+iw*(i+.5)/cs.length,h=ih*(s.velocity||0)/mx,yy=T+ih-h;out+='<g class="bar-g"><path d="M'+(cx-bw/2)+' '+(T+ih)+' V'+(yy+4)+' Q'+(cx-bw/2)+' '+yy+' '+(cx-bw/2+4)+' '+yy+' H'+(cx+bw/2-4)+' Q'+(cx+bw/2)+' '+yy+' '+(cx+bw/2)+' '+(yy+4)+' V'+(T+ih)+'Z" class="vbar"><title>'+esc(s.name)+': '+(s.velocity||0)+' pts</title></path><text x="'+cx+'" y="'+(yy-5)+'" class="ax val" text-anchor="middle">'+(s.velocity||0)+'</text><text x="'+cx+'" y="'+(H-10)+'" class="ax" text-anchor="middle">'+esc(s.name.replace(/^Sprint\s*/i,"S"))+'</text></g>'});
  if(avg){var ya=T+ih*(1-avg/mx);out+='<line x1="'+L+'" x2="'+(W-R)+'" y1="'+ya+'" y2="'+ya+'" class="avg"/><text x="'+(W-R)+'" y="'+(ya-5)+'" class="ax" text-anchor="end">avg '+avg+'</text>'}
  return'<svg class="chart-svg" viewBox="0 0 '+W+' '+H+'" role="img" aria-label="Velocity per sprint, average '+avg+' points">'+out+'</svg>'}
function statusStack(){var t=D().tasks,tot=t.length||1;var cls={Backlog:"s0","To Do":"s1","In Progress":"s2",Review:"s3",Done:"s4"};
  return'<div class="stack">'+COLS.map(function(c){var n=t.filter(function(x){return x.status===c}).length;return n?'<span class="'+cls[c]+'" style="flex:'+n+'" title="'+c+': '+n+'"></span>':''}).join("")+'</div><div class="legend wrap">'+COLS.map(function(c){var n=t.filter(function(x){return x.status===c}).length;return'<span><i class="sw '+cls[c]+'"></i>'+c+' <b>'+n+'</b></span>'}).join("")+'</div>'}
function workloadBars(){var t=D().tasks;var rows=S.members.map(function(m){var open=t.filter(function(x){return x.assignee===m.id&&x.status!=="Done"&&x.status!=="Backlog"}).reduce(function(a,x){return a+(+x.points||0)},0);var done=t.filter(function(x){return x.assignee===m.id&&x.status==="Done"&&x.done_at>=addDays(-7)}).reduce(function(a,x){return a+(+x.points||0)},0);return{m:m,open:open,done:done}});
  var mx=Math.max.apply(null,rows.map(function(r){return Math.max(r.open,r.done)}).concat([1]));
  return'<div class="legend"><span><i class="sw act"></i>Open pts</span><span><i class="sw s4"></i>Done last 7 days</span></div>'+rows.map(function(r){return'<div class="wrow"><div class="wname">'+avatar(r.m.id,1)+'<span>'+esc(r.m.name)+'</span></div><div class="wbars"><div class="hbar"><i style="width:'+(r.open/mx*100)+'%" class="act" title="'+r.open+' open pts"></i><b>'+r.open+'</b></div><div class="hbar"><i style="width:'+(r.done/mx*100)+'%" class="s4" title="'+r.done+' pts done in 7 days"></i><b>'+r.done+'</b></div></div></div>'}).join("")}
function riskMatrix(){var rs=D().risks.filter(function(r){return r.status==="Open"});var h='<div class="rmx"><div class="rmy">Impact →</div><div class="rmgrid">';
  for(var im=5;im>=1;im--)for(var pr=1;pr<=5;pr++){var c=rs.filter(function(r){return+r.prob===pr&&+r.impact===im});var sc=pr*im;h+='<div class="rc '+riskCls(sc)+(c.length?" has":"")+'" title="P'+pr+' × I'+im+' = '+sc+(c.length?": "+c.map(function(r){return r.title}).join("; "):"")+'">'+(c.length||"")+'</div>'}
  return h+'</div><div class="rmx-x">Probability →</div></div>'}
function deadlines(){var t=D().tasks.filter(function(x){return x.status!=="Done"&&x.due&&x.due<=addDays(7)}).sort(function(a,b){return a.due.localeCompare(b.due)}).slice(0,7);
  if(!t.length)return'<div class="empty small">Nothing due in the next 7 days.</div>';
  return t.map(function(x){var od=x.due<today();return'<div class="lrow" data-a="editTask" data-v="'+x.id+'" style="cursor:pointer"><span class="dbadge'+(od?" od":x.due===today()?" td":"")+'"><b>'+new Date(x.due+"T00:00:00").getDate()+'</b>'+new Date(x.due+"T00:00:00").toLocaleDateString(undefined,{month:"short"})+'</span><div class="grow"><div class="lt">'+esc(x.title)+'</div><div class="small muted">'+(od?'<span class="overdue">Overdue</span> · ':'')+x.status+(x.priority?' · '+PRILABEL[x.priority]:'')+'</div></div>'+(x.assignee?avatar(x.assignee,1):'')+'</div>'}).join("")}
function kpiStrip(){var b=myBrief(),sp=activeSprint(),p=P();var ip=D().tasks.filter(function(t){return t.status==="In Progress"}).length;var spTxt="None",spPct=0,spSub="Plan one";
  if(sp){var st=sprintTasks(sp),tot=st.reduce(function(a,t){return a+(+t.points||0)},0),dn=st.filter(function(t){return t.status==="Done"}).reduce(function(a,t){return a+(+t.points||0)},0);spTxt=dn+'<small>/'+tot+' pts</small>';spPct=tot?dn/tot*100:0;spSub='<span class="bar"><i style="width:'+spPct+'%"></i></span>'}
  var k=function(label,val,cls,act,sub){return'<button class="kpi '+(cls||"")+'" '+act+'><span class="kl">'+label+'</span><span class="kv">'+val+'</span><span class="ks">'+(sub||"")+'</span></button>'};
  return'<div class="kpis">'+k("Due today",b.dueToday.length,b.dueToday.length?"warn":"",'data-a="bfilter" data-v="mine"',"assigned to you")+k("Overdue",b.overdue.length,b.overdue.length?"bad":"",'data-a="bfilter" data-v="mine"',"yours")+k("In progress",ip+'<small>/'+p.wip_limit+'</small>',ip>p.wip_limit?"bad":"",'data-a="tab" data-v="board"',"WIP limit")+k("To review",b.review,b.review?"info":"",'data-a="tab" data-v="board"',"from teammates")+k(sp?esc(sp.name):"Sprint",spTxt,"",'data-a="tab" data-v="sprint"',spSub)+'</div>'}
function renderDash(){var p=P(),sp=activeSprint(),r=rag();
  var h=kpiStrip()+'<div class="dash">';
  h+='<div class="card span8"><div class="row between"><h3 style="margin:0">'+(sp?esc(sp.name)+' · burndown':'Sprint burndown')+'</h3>'+(sp?'<button class="btn ghost small" data-a="tab" data-v="sprint">Open sprint</button>':'<button class="btn small" data-a="editSprint" data-v="">Plan a sprint</button>')+'</div>'+(sp?(sp.goal?'<p class="small muted" style="margin:4px 0 8px">🎯 '+esc(sp.goal)+'</p>':'')+burndownSVG(sp):'<div class="empty">No active sprint. Plan one to see the burndown.</div>')+'</div>';
  h+='<div class="card span4"><h3>Sprint calendar</h3>'+(sp?timeline(sp):'<div class="empty small">No active sprint.</div>')+upcoming()+'</div>';
  h+='<div class="card span4"><div class="row between"><h3 style="margin:0">Status report</h3><span class="rag '+r+'">'+({G:"Green",A:"Amber",R:"Red"})[r]+'</span></div><div class="small muted" style="margin:6px 0">'+progress()+'% of planned points done</div><div class="bar"><i style="width:'+progress()+'%"></i></div>'+reportMini()+'<div class="row" style="margin-top:10px"><button class="btn small" data-a="copyReport2">Copy full report</button><button class="btn ghost small" data-a="goto" data-v="coach" data-s="report">Edit asks</button></div></div>';
  h+='<div class="card span4"><h3>Velocity</h3>'+velocitySVG()+'</div>';
  h+='<div class="card span4"><h3>Work by status</h3>'+statusStack()+'<h3 style="margin-top:16px">Workload</h3>'+workloadBars()+'</div>';
  h+='<div class="card span6"><h3>Due in the next 7 days</h3>'+deadlines()+'</div>';
  h+='<div class="card span6"><div class="row between"><h3 style="margin:0">Risk heat map</h3><button class="btn ghost small" data-a="goto" data-v="plan" data-s="risks">Risk register</button></div><p class="small muted" style="margin:4px 0 8px">Open risks by probability × impact. Hover a cell for details.</p>'+riskMatrix()+'</div>';
  return h+'</div>'}
function timeline(sp){var s0=new Date(sp.start_date+"T00:00:00"),e0=new Date(sp.end_date+"T23:59:59"),span=e0-s0,now=new Date();
  var pos=function(d){return Math.max(0,Math.min(100,(d-s0)/span*100))};var pl=sp.planning_at?new Date(sp.planning_at):s0,rt=sp.retro_at?new Date(sp.retro_at):new Date(sp.end_date+"T16:00:00");
  return'<div class="tl"><div class="tlbar"><i style="width:'+pos(now)+'%"></i><span class="tm pl" style="left:'+pos(pl)+'%" title="Sprint planning"></span><span class="tm rt" style="left:'+pos(rt)+'%" title="Retrospective"></span><span class="tnow" style="left:'+pos(now)+'%"></span></div><div class="row between small muted"><span>'+fmtDate(sp.start_date)+'</span><span>'+fmtDate(sp.end_date)+'</span></div></div>'+
  '<div class="cerlist"><div class="cerrow"><span class="cic">🗓</span><div class="grow"><b>Sprint planning</b><div class="small muted">'+fmtDT(pl)+'</div></div>'+(pl<now?'<span class="pill st-Done">Done</span>':'<span class="pill">Upcoming</span>')+'</div>'+
  '<div class="cerrow"><span class="cic">⏱</span><div class="grow"><b>Daily standup</b><div class="small muted">Every day · 2 min in the app</div></div>'+(myBrief().posted?'<span class="pill st-Done">Posted</span>':'<button class="btn ghost small" data-a="goto" data-v="sprint" data-s="standup">Post</button>')+'</div>'+
  '<div class="cerrow"><span class="cic">🔁</span><div class="grow"><b>Review & retrospective</b><div class="small muted">'+fmtDT(rt)+'</div></div>'+(rt<now?'<span class="pill st-Done">Done</span>':'<span class="pill st-InProgress">In '+Math.max(0,Math.ceil((rt-now)/864e5))+'d</span>')+'</div></div>'+
  '<button class="btn ghost small" data-a="editSprint" data-v="'+sp.id+'">Edit dates</button>'}
function upcoming(){var next=D().sprints.filter(function(s){return s.status==="Planned"})[0];return next?'<div class="small muted" style="margin-top:8px">Next: '+esc(next.name)+' starts '+fmtDate(next.start_date)+'</div>':''}
function reportMini(){var done=D().tasks.filter(function(t){return t.status==="Done"&&t.done_at>=addDays(-7)}).length;var bl=D().tasks.filter(function(t){return isBlocked(t)&&t.status!=="Backlog"}).length+D().tasks.filter(isOverdue).length;var rk=D().risks.filter(function(x){return x.status==="Open"&&riskScore(x)>=12}).length;
  return'<div class="rmini"><div><b>'+done+'</b><span>done this week</span></div><div><b>'+bl+'</b><span>blockers & delays</span></div><div><b>'+rk+'</b><span>high risks</span></div></div>'}

/* ---------- Ideas: brainstorm whiteboard ---------- */
var WBC={yellow:"#fde68a",pink:"#fbcfe8",blue:"#bfdbfe",green:"#bbf7d0",purple:"#ddd6fe",orange:"#fed7aa"};
var WB={tool:"select",color:null,sel:null,linkFrom:null,drag:null,pointers:{},pinch:null,editing:null};
function wbView(){var v=S.wbViews=S.wbViews||{};var k=WB.boardId||S.cur;return v[k]=v[k]||{x:40,y:30,k:1}}
function wbItems(){var b=WB.boardId;return(D().board_items||[]).filter(function(i){return i.board_id===b})}
function boards(){return(D().boards||[]).slice().sort(function(a,b){return String(b.updated_at||b.created_at).localeCompare(String(a.updated_at||a.created_at))})}
function curBoard(){return(D().boards||[]).filter(function(b){return b.id===WB.boardId})[0]}
function wbItem(id){return wbItems().filter(function(i){return i.id===id})[0]}
function wbDefColor(){return WB.color||(theme==="squid"?"purple":theme==="cat"?"orange":"yellow")}
async function ensureBoards(){var legacy=(D().board_items||[]).filter(function(i){return!i.board_id});if(!legacy.length||S.migratingBoards)return;S.migratingBoards=true;
  try{var b={id:uuid(),project_id:P().id,name:"Main board",created_by:S.user.id};await DB.ins("boards",b);for(var i=0;i<legacy.length;i++)await DB.upd("board_items",legacy[i].id,{board_id:b.id});await loadProject(true)}catch(e){toast("⚠ "+e.message)}S.migratingBoards=false}
function renderIdeas(){
  if(S.missing&&S.missing.boards)return'<div class="card" style="max-width:640px"><h3>One database update needed</h3><p class="small muted">Multiple idea boards and PNG snapshots need two new tables. Ask the project owner to run the latest <b>supabase/schema.sql</b> in the Supabase SQL Editor (safe to re-run), then reload Tandem.</p></div>';
  if(!(D().boards||[]).length&&(D().board_items||[]).some(function(i){return!i.board_id})){setTimeout(ensureBoards,0);return'<div class="empty">Preparing your boards…</div>'}
  if(!WB.boardId||!curBoard()){WB.boardId=null;return renderGallery()}
  return renderBoardView()}
function renderGallery(){var bs=boards();var cnt=function(b){return(D().board_items||[]).filter(function(i){return i.board_id===b.id&&i.kind!=="link"&&i.kind!=="frame"}).length};
  return'<div class="row between" style="margin-bottom:12px"><div><h2 style="margin:0">Idea boards</h2><div class="small muted">'+bs.length+' board'+(bs.length===1?"":"s")+' · brainstorm, map ideas, save snapshots as PNG</div></div><button class="btn" data-a="wbNew">+ New board</button></div>'+
  '<div class="bgal">'+bs.map(function(b){return'<div class="bcard" data-a="wbOpen" data-v="'+b.id+'"><div class="bthumb">'+(b.thumbnail?'<img src="'+b.thumbnail+'" alt="">':'<div class="bph"><span style="background:#fde68a"></span><span style="background:#fbcfe8"></span><span style="background:#bfdbfe"></span><span style="background:#bbf7d0"></span></div>')+'</div><div class="bmeta"><div class="grow" style="min-width:0"><div class="bname">'+esc(b.name)+'</div><div class="small muted">'+cnt(b)+' notes · '+ago(b.updated_at||b.created_at)+'</div></div><button class="iconbtn sm" data-a="wbMenu" data-v="'+b.id+'" aria-label="Board options">⋯</button></div></div>'}).join("")+
  '<button class="bcard bnew" data-a="wbNew"><span>+</span><b>New board</b><span class="small muted">Blank or from a template</span></button></div>'}
function renderBoardView(){var b=curBoard();return renderIdeasCanvas().replace('<div class="wbtools"','<div class="wbtop"><button class="wbt-btn wide" data-wb="back" title="All boards">←<span class="lbl"> Boards</span></button><input class="wbname" id="wbname" value="'+esc(b.name)+'" aria-label="Board name"><button class="wbt-btn wide" data-wb="snaps" title="Saved PNG snapshots">🖼<span class="lbl"> Snapshots</span></button><button class="btn small" data-wb="png" title="Save as PNG">⬇<span class="lbl"> Save PNG</span></button></div><div class="wbtools"')}
function renderIdeasCanvas(){
  var tools=[["select","Select & move","M5 3l14 8-6 2-2 6z"],["sticky","Sticky note","M4 4h16v11l-5 5H4z M15 20v-5h5"],["text","Text","M5 6V4h14v2 M12 4v16 M9 20h6"],["frame","Section","M3 7h18 M3 3h18v18H3z"],["link","Connect with arrow","M5 19L19 5 M13 5h6v6"],["vote","Vote","M12 21s-7-4.5-7-10a4 4 0 0 1 7-2.6A4 4 0 0 1 19 11c0 5.5-7 10-7 10z"]];
  var v=wbView();
  return'<div class="wbwrap" id="wbwrap"><div class="wbtools" role="toolbar">'+tools.map(function(t){return'<button class="wbt-btn'+(WB.tool===t[0]?" on":"")+'" data-wb="tool" data-v="'+t[0]+'" title="'+t[1]+'"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="'+t[2]+'"/></svg></button>'}).join("")+
  '<span class="wbsep"></span><div class="wbcolors">'+Object.keys(WBC).map(function(c){return'<button class="wbsw'+(wbDefColor()===c?" on":"")+'" data-wb="color" data-v="'+c+'" style="background:'+WBC[c]+'" title="'+c+' sticky"></button>'}).join("")+'</div><span class="wbsep"></span>'+
  '<button class="wbt-btn wide" data-wb="tpl" title="Templates">Templates</button></div>'+
  '<div class="wbzoom"><button data-wb="zoom" data-v="-1" title="Zoom out">−</button><span id="wbk">'+Math.round(v.k*100)+'%</span><button data-wb="zoom" data-v="1" title="Zoom in">+</button><button data-wb="fit" title="Fit to screen">Fit</button></div>'+
  '<div class="wbvp" id="wbvp"><div class="wbcanvas" id="wbc"></div></div>'+
  '<div class="wbsel" id="wbsel" hidden></div>'+
  '<div class="wbhint" id="wbhint">'+wbHint()+'</div></div>'}
function wbHint(){return{select:"Drag to move · double-click to edit · drag empty space to pan · Ctrl/⌘ + scroll or pinch to zoom",sticky:"Click anywhere to drop a sticky note",text:"Click anywhere to add text",frame:"Click to add a section. Stickies inside move with it",link:WB.linkFrom?"Now click the note to point at":"Click a note to start an arrow",vote:"Click notes to vote +1 (right-click / long-press to remove)"}[WB.tool]}
function wbTransform(){var v=wbView(),c=document.getElementById("wbc");if(c)c.style.transform="translate("+v.x+"px,"+v.y+"px) scale("+v.k+")";var k=document.getElementById("wbk");if(k)k.textContent=Math.round(v.k*100)+"%";var vp=document.getElementById("wbvp");if(vp){vp.style.backgroundSize=(24*v.k)+"px "+(24*v.k)+"px";vp.style.backgroundPosition=v.x+"px "+v.y+"px"}}
function wbToCanvas(cx,cy){var vp=document.getElementById("wbvp").getBoundingClientRect(),v=wbView();return{x:(cx-vp.left-v.x)/v.k,y:(cy-vp.top-v.y)/v.k}}
function wbItemHTML(it){if(it.kind==="link")return"";var cls="wbi "+it.kind+(it.kind!=="text"?" c-"+(it.color||"yellow"):"")+(WB.sel===it.id?" sel":"")+(WB.linkFrom===it.id?" linkfrom":"");
  var body=it.kind==="frame"?'<div class="wbfh">'+(esc(it.text)||"Section")+'</div>':'<div class="wbtx">'+(esc(it.text).replace(/\n/g,"<br>")||(it.kind==="text"?'<span class="ph">Text</span>':'<span class="ph">Double-click to write</span>'))+'</div>';
  return'<div class="'+cls+'" data-id="'+it.id+'" style="left:'+it.x+'px;top:'+it.y+'px;width:'+it.w+'px;'+(it.kind==="text"?"min-height:"+it.h+"px":"height:"+it.h+"px")+';z-index:'+(it.kind==="frame"?1:10+(it.z||0))+'">'+body+
  (it.votes>0?'<span class="wbvote">♥ '+it.votes+'</span>':'')+(it.task_id?'<span class="wbtask" title="Turned into a task">✓ task</span>':'')+(it.created_by&&member(it.created_by)&&it.kind==="sticky"?'<span class="wbby">'+esc(initials(mname(it.created_by)))+'</span>':'')+
  (it.kind!=="text"?'<span class="wbrz" data-rz="1"></span>':'')+'</div>'}
function wbLinksSVG(){var items=wbItems(),out="";items.filter(function(i){return i.kind==="link"}).forEach(function(l){var a=wbItem(l.from_id),b=wbItem(l.to_id);if(!a||!b)return;
  var ac={x:a.x+a.w/2,y:a.y+a.h/2},bc={x:b.x+b.w/2,y:b.y+b.h/2};var p1=edge(a,bc),p2=edge(b,ac);
  out+='<g class="wblink'+(WB.sel===l.id?" sel":"")+'" data-id="'+l.id+'"><path d="M'+p1.x+' '+p1.y+' L'+p2.x+' '+p2.y+'" class="hitl"/><path d="M'+p1.x+' '+p1.y+' L'+p2.x+' '+p2.y+'" marker-end="url(#wbarrow)"/></g>'});
  return'<svg class="wblinks" width="1" height="1"><defs><marker id="wbarrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" fill="currentColor"/></marker></defs>'+out+'</svg>';
  function edge(r,t){var cx=r.x+r.w/2,cy=r.y+r.h/2,dx=t.x-cx,dy=t.y-cy;if(!dx&&!dy)return{x:cx,y:cy};var sx=(r.w/2+6)/Math.abs(dx||1e-9),sy=(r.h/2+6)/Math.abs(dy||1e-9),s=Math.min(sx,sy);return{x:cx+dx*s,y:cy+dy*s}}}
function wbDraw(){var c=document.getElementById("wbc");if(!c)return;var items=wbItems();
  c.innerHTML=wbLinksSVG()+items.filter(function(i){return i.kind==="frame"}).map(wbItemHTML).join("")+items.filter(function(i){return i.kind!=="frame"&&i.kind!=="link"}).map(wbItemHTML).join("")+
  (items.length?"":'<div class="wbempty"><b>Your brainstorm board</b><span>Pick a template, or click the sticky tool and start dropping ideas.</span><span><button class="btn small" data-wb="tplpick" data-v="brainstorm">Brainstorm template</button> <button class="btn ghost small" data-wb="tplpick" data-v="mindmap">Mind map</button></span></div>');
  wbSelBar()}
function wbRedrawLinks(){var c=document.getElementById("wbc");if(!c)return;var old=c.querySelector(".wblinks");if(old)old.outerHTML=wbLinksSVG()}
function wbSave(id,patch){WB.dirty=true;var it=wbItem(id);if(it)for(var k in patch)it[k]=patch[k];return DB.upd("board_items",id,patch).catch(function(e){toast("⚠ "+e.message)})}
function wbAdd(row){row.id=uuid();row.project_id=P().id;row.board_id=WB.boardId;WB.dirty=true;row.created_by=S.user.id;row.votes=0;row.created_at=new Date().toISOString();row.z=row.z||wbItems().reduce(function(a,i){return Math.max(a,i.z||0)},0)+1;
  if(!S.d.board_items)S.d.board_items=[];S.d.board_items.push(row);buzz(8);var send={};for(var k in row)if(k!=="created_at")send[k]=row[k];DB.ins("board_items",send).catch(function(e){toast("⚠ "+e.message)});return row}
function wbDel(id){WB.dirty=true;var ids=[id];wbItems().forEach(function(i){if(i.kind==="link"&&(i.from_id===id||i.to_id===id))ids.push(i.id)});S.d.board_items=wbItems().filter(function(i){return ids.indexOf(i.id)<0});WB.sel=null;wbDraw();DB.del("board_items",id).catch(function(e){toast("⚠ "+e.message)})}
function wbSelBar(){var bar=document.getElementById("wbsel");if(!bar)return;var it=WB.sel&&wbItem(WB.sel);if(!it||WB.editing){bar.hidden=true;return}
  var html=it.kind==="link"?'<button data-wb="del">Delete arrow</button>':
  (it.kind==="sticky"||it.kind==="frame"?Object.keys(WBC).map(function(c){return'<button class="wbsw'+(it.color===c?" on":"")+'" data-wb="recolor" data-v="'+c+'" style="background:'+WBC[c]+'"></button>'}).join("")+'<span class="wbsep"></span>':'')+
  '<button data-wb="edit">Edit</button>'+(it.kind!=="frame"?'<button data-wb="mktask">'+(it.task_id?"✓ Task":"→ Make task")+'</button><button data-wb="vote1">♥ '+(it.votes||0)+'</button>':'')+'<button data-wb="dup">Duplicate</button><button data-wb="front">Front</button><button data-wb="del" class="danger">Delete</button>';
  bar.innerHTML=html;bar.hidden=false;
  if(it.kind==="link"){var a=wbItem(it.from_id),b=wbItem(it.to_id);if(!a||!b)return;var mx=(a.x+a.w/2+b.x+b.w/2)/2,my=(a.y+a.h/2+b.y+b.h/2)/2;pos(mx,my)}else pos(it.x+it.w/2,it.y);
  function pos(cx,cy){var v=wbView(),vp=document.getElementById("wbvp"),wr=document.getElementById("wbwrap").getBoundingClientRect(),r=vp.getBoundingClientRect();var sx=r.left-wr.left+v.x+cx*v.k,sy=r.top-wr.top+v.y+cy*v.k-12;bar.style.left=Math.max(8,Math.min(wr.width-bar.offsetWidth-8,sx-bar.offsetWidth/2))+"px";bar.style.top=Math.max(56,sy-bar.offsetHeight)+"px"}}
function wbEdit(id){var it=wbItem(id);if(!it)return;var el=document.querySelector('.wbi[data-id="'+id+'"]');if(!el)return;WB.editing=id;S.wbBusy=true;wbSelBar();
  var host=it.kind==="frame"?el.querySelector(".wbfh"):el.querySelector(".wbtx");var ta=document.createElement("textarea");ta.className="wbedit"+(it.kind==="frame"?" fh":"");ta.value=it.text||"";host.innerHTML="";host.appendChild(ta);ta.focus();ta.select();
  var done=function(save){if(WB.editing!==id)return;WB.editing=null;S.wbBusy=false;if(save&&ta.value!==it.text)wbSave(id,{text:ta.value});wbDraw();if(S.wbPending){S.wbPending=false;loadProject(true)}};
  ta.addEventListener("blur",function(){done(true)});ta.addEventListener("keydown",function(e){e.stopPropagation();if(e.key==="Escape"){done(false)}if(e.key==="Enter"&&(e.metaKey||e.ctrlKey||(!e.shiftKey&&it.kind==="frame"))){e.preventDefault();ta.blur()}});
  ta.addEventListener("pointerdown",function(e){e.stopPropagation()})}
function wbFit(){var it=wbItems().filter(function(i){return i.kind!=="link"});var vp=document.getElementById("wbvp");if(!vp)return;var r=vp.getBoundingClientRect(),v=wbView();
  if(!it.length){v.x=40;v.y=30;v.k=1;wbTransform();return}var x0=Math.min.apply(null,it.map(function(i){return i.x})),y0=Math.min.apply(null,it.map(function(i){return i.y})),x1=Math.max.apply(null,it.map(function(i){return i.x+i.w})),y1=Math.max.apply(null,it.map(function(i){return i.y+i.h}));
  var top=isPhone()?110:70;var k=Math.min(1.4,Math.max(.2,Math.min((r.width-40)/(x1-x0),(r.height-top-70)/(y1-y0))));v.k=k;v.x=(r.width-(x1-x0)*k)/2-x0*k;v.y=top+(r.height-top-60-(y1-y0)*k)/2-y0*k;wbTransform();wbSelBar()}
function wbZoomAt(f,cx,cy){var v=wbView(),vp=document.getElementById("wbvp").getBoundingClientRect();var px=cx==null?vp.width/2:cx-vp.left,py=cy==null?vp.height/2:cy-vp.top;var k=Math.max(.2,Math.min(2.5,v.k*f));v.x=px-(px-v.x)*k/v.k;v.y=py-(py-v.y)*k/v.k;v.k=k;wbTransform();wbSelBar()}
function wbCenter(){var vp=document.getElementById("wbvp").getBoundingClientRect(),v=wbView();return{x:(vp.width/2-v.x)/v.k,y:(vp.height/2-v.y)/v.k}}
function wbTemplate(name){var c=wbCenter(),col=wbDefColor();var add=function(o){return wbAdd(o)};
  var ex=wbItems().filter(function(i){return i.kind!=="link"});if(ex.length){var x1=Math.max.apply(null,ex.map(function(i){return i.x+i.w})),y0=Math.min.apply(null,ex.map(function(i){return i.y}));var tw0=name==="canvas"?1320:name==="ssc"?1320:name==="mindmap"?800:870,th0=name==="canvas"?710:name==="ssc"?340:name==="mindmap"?560:710;c={x:x1+160+tw0/2,y:y0+th0/2}}
  if(name==="brainstorm"||name==="canvas"||name==="ssc"){var secs=name==="brainstorm"?[["🎯 Goals","green"],["💡 Ideas","yellow"],["⚠️ Risks","pink"],["❓ Questions","blue"]]:name==="canvas"?[["Problem","pink"],["Solution","yellow"],["Who it's for","blue"],["Success metrics","green"],["Risks","orange"],["Next steps","purple"]]:[["▶ Start","green"],["■ Stop","pink"],["↻ Continue","blue"]];
    var cols=name==="canvas"?3:secs.length===4?2:3,W=420,H=340,gap=30,tw=cols*W+(cols-1)*gap,rows=Math.ceil(secs.length/cols),th=rows*H+(rows-1)*gap;
    secs.forEach(function(s,i){var x=c.x-tw/2+(i%cols)*(W+gap),y=c.y-th/2+Math.floor(i/cols)*(H+gap);add({kind:"frame",x:x,y:y,w:W,h:H,text:s[0],color:s[1]});add({kind:"sticky",x:x+24,y:y+60,w:170,h:120,text:"",color:s[1]})})}
  if(name==="mindmap"){var mid=add({kind:"sticky",x:c.x-110,y:c.y-70,w:220,h:140,text:P().name,color:col});
    [["Who","blue",-380,-220],["What","green",200,-220],["How","yellow",-380,160],["When","pink",200,160]].forEach(function(b){var n=add({kind:"sticky",x:c.x+b[2],y:c.y+b[3],w:180,h:110,text:b[0],color:b[1]});add({kind:"link",x:0,y:0,w:0,h:0,from_id:mid.id,to_id:n.id})})}
  WB.tool="select";wbDraw();setTimeout(wbFit,30);toast("Template added")}
function mountWB(){var vp=document.getElementById("wbvp");if(!vp)return;wbTransform();wbDraw();
  var wrap=document.getElementById("wbwrap");
  wrap.addEventListener("click",function(e){var b=e.target.closest("[data-wb]");if(!b)return;e.stopPropagation();var a=b.dataset.wb,v=b.dataset.v,it=WB.sel&&wbItem(WB.sel);
    if(a==="tool"){WB.tool=v;WB.linkFrom=null;wrap.querySelectorAll('[data-wb=tool]').forEach(function(x){x.classList.toggle("on",x.dataset.v===v)});document.getElementById("wbhint").textContent=wbHint();vp.dataset.tool=v;wbDraw()}
    if(a==="color"){WB.color=v;wrap.querySelectorAll('.wbcolors .wbsw').forEach(function(x){x.classList.toggle("on",x.dataset.v===v)});if(WB.tool!=="sticky"){WB.tool="sticky";wrap.querySelectorAll('[data-wb=tool]').forEach(function(x){x.classList.toggle("on",x.dataset.v==="sticky")});vp.dataset.tool="sticky";document.getElementById("wbhint").textContent=wbHint()}}
    if(a==="zoom")wbZoomAt(v==="1"?1.2:1/1.2);
    if(a==="fit")wbFit();
    if(a==="tpl"){modal('<div class="mh"><h3>Templates</h3><button class="x" data-a="close">×</button></div><p class="small muted">Adds a ready-made layout at the centre of the board.</p><div class="tplgrid">'+[["brainstorm","Brainstorm","Goals · Ideas · Risks · Questions"],["mindmap","Mind map","Project in the middle, branches around it"],["canvas","Project canvas","Problem → solution → success → next steps"],["ssc","Start · Stop · Continue","Quick retro or kickoff"]].map(function(t){return'<button class="tplcard" data-a="wbtpl" data-v="'+t[0]+'"><b>'+t[1]+'</b><span>'+t[2]+'</span></button>'}).join("")+'</div>')}
    if(a==="tplpick")wbTemplate(v);
    if(a==="back"){wbLeave().then(function(){WB.boardId=null;WB.sel=null;S.lastKey=null;render()});return}
    if(a==="png"){wbSavePNG();return}
    if(a==="snaps"){openSnaps();return}
    if(!it)return;
    if(a==="recolor"){wbSave(it.id,{color:v});wbDraw()}
    if(a==="edit")wbEdit(it.id);
    if(a==="del")wbDel(it.id);
    if(a==="vote1"){wbSave(it.id,{votes:(it.votes||0)+1});buzz(8);wbDraw()}
    if(a==="front"){wbSave(it.id,{z:wbItems().reduce(function(m,i){return Math.max(m,i.z||0)},0)+1});wbDraw()}
    if(a==="dup"){var n=wbAdd({kind:it.kind,x:it.x+24,y:it.y+24,w:it.w,h:it.h,text:it.text,color:it.color});WB.sel=n.id;wbDraw()}
    if(a==="mktask"){if(it.task_id){S.tab="board";render();editTask(it.task_id);return}var title=(it.text||"").split("\n")[0].trim().slice(0,140);if(!title){toast("Write something on the sticky first");return}var tid=uuid();
      act(function(){return DB.ins("tasks",{id:tid,project_id:P().id,title:title,status:"Backlog",description:(it.text||"").indexOf("\n")>0?it.text:"",assignee:null})},"Added to the Backlog").then(function(){wbSave(it.id,{task_id:tid});wbDraw()})}
  });
  vp.dataset.tool=WB.tool;
  var nm=document.getElementById("wbname");if(nm){nm.addEventListener("keydown",function(e){e.stopPropagation();if(e.key==="Enter")nm.blur()});nm.addEventListener("change",function(){var b=curBoard(),v=nm.value.trim()||"Untitled board";if(b&&v!==b.name){b.name=v;DB.upd("boards",b.id,{name:v,updated_at:new Date().toISOString()}).catch(function(e){toast("⚠ "+e.message)})}})}
  vp.addEventListener("wheel",function(e){e.preventDefault();var v=wbView();if(e.ctrlKey||e.metaKey)wbZoomAt(Math.exp(-e.deltaY*0.0022),e.clientX,e.clientY);else{v.x-=e.deltaX;v.y-=e.deltaY;wbTransform();wbSelBar()}},{passive:false});
  vp.addEventListener("contextmenu",function(e){var el=e.target.closest(".wbi");if(el&&WB.tool==="vote"){e.preventDefault();var it=wbItem(el.dataset.id);if(it&&it.votes>0){wbSave(it.id,{votes:it.votes-1});wbDraw()}}});
  vp.addEventListener("dblclick",function(e){var el=e.target.closest(".wbi");if(el){wbEdit(el.dataset.id);return}var p=wbToCanvas(e.clientX,e.clientY);var n=wbAdd({kind:"sticky",x:p.x-90,y:p.y-60,w:180,h:120,text:"",color:wbDefColor()});WB.sel=n.id;wbDraw();wbEdit(n.id)});
  vp.addEventListener("pointerdown",function(e){if(WB.editing)return;WB.pointers[e.pointerId]={x:e.clientX,y:e.clientY};
    var ids=Object.keys(WB.pointers);if(ids.length===2){var a=WB.pointers[ids[0]],b=WB.pointers[ids[1]];WB.pinch={d:Math.hypot(a.x-b.x,a.y-b.y),k:wbView().k,cx:(a.x+b.x)/2,cy:(a.y+b.y)/2};WB.drag=null;return}
    var lk=e.target.closest(".wblink"),el=e.target.closest(".wbi"),p=wbToCanvas(e.clientX,e.clientY);
    if(lk&&WB.tool==="select"){WB.sel=lk.dataset.id;wbDraw();return}
    if(!el){ if(WB.tool==="sticky"||WB.tool==="text"||WB.tool==="frame"){var t=WB.tool;var n=wbAdd(t==="frame"?{kind:"frame",x:p.x-200,y:p.y-30,w:420,h:320,text:"Section",color:"blue"}:t==="text"?{kind:"text",x:p.x-10,y:p.y-14,w:220,h:30,text:"",color:"yellow"}:{kind:"sticky",x:p.x-90,y:p.y-60,w:180,h:120,text:"",color:wbDefColor()});WB.sel=n.id;wbDraw();if(t!=="frame")wbEdit(n.id);return}
      WB.sel=null;WB.linkFrom=null;wbDraw();var v=wbView();WB.drag={pan:true,sx:e.clientX,sy:e.clientY,vx:v.x,vy:v.y};vp.setPointerCapture(e.pointerId);vp.classList.add("panning");return}
    var it=wbItem(el.dataset.id);if(!it)return;
    if(WB.tool==="link"){if(!WB.linkFrom){WB.linkFrom=it.id;document.getElementById("wbhint").textContent=wbHint();wbDraw()}else if(WB.linkFrom!==it.id){wbAdd({kind:"link",x:0,y:0,w:0,h:0,from_id:WB.linkFrom,to_id:it.id});WB.linkFrom=null;document.getElementById("wbhint").textContent=wbHint();wbDraw()}return}
    if(WB.tool==="vote"){if(it.kind!=="frame"){wbSave(it.id,{votes:(it.votes||0)+1});buzz(8);wbDraw()}return}
    WB.sel=it.id;var rz=!!e.target.closest("[data-rz]");var group=[];
    if(it.kind==="frame"&&!rz)wbItems().forEach(function(o){if(o.id!==it.id&&o.kind!=="link"&&o.kind!=="frame"&&o.x>=it.x&&o.y>=it.y&&o.x+o.w<=it.x+it.w&&o.y+o.h<=it.y+it.h)group.push({id:o.id,x:o.x,y:o.y})});
    WB.drag={id:it.id,rz:rz,sx:p.x,sy:p.y,ox:it.x,oy:it.y,ow:it.w,oh:it.h,group:group,moved:false};S.wbBusy=true;vp.setPointerCapture(e.pointerId);
    document.querySelectorAll(".wbi.sel").forEach(function(x){x.classList.remove("sel")});el.classList.add("sel","lift");document.getElementById("wbsel").hidden=true});
  vp.addEventListener("pointermove",function(e){if(WB.pointers[e.pointerId])WB.pointers[e.pointerId]={x:e.clientX,y:e.clientY};
    if(WB.pinch){var ids=Object.keys(WB.pointers);if(ids.length<2)return;var a=WB.pointers[ids[0]],b=WB.pointers[ids[1]],d=Math.hypot(a.x-b.x,a.y-b.y);wbZoomAt(WB.pinch.k*d/WB.pinch.d/wbView().k,WB.pinch.cx,WB.pinch.cy);return}
    var g=WB.drag;if(!g)return;
    if(g.pan){var v=wbView();v.x=g.vx+e.clientX-g.sx;v.y=g.vy+e.clientY-g.sy;wbTransform();return}
    var p=wbToCanvas(e.clientX,e.clientY),dx=p.x-g.sx,dy=p.y-g.sy;if(Math.abs(dx)+Math.abs(dy)>2)g.moved=true;var it=wbItem(g.id),el=document.querySelector('.wbi[data-id="'+g.id+'"]');if(!it||!el)return;
    if(g.rz){it.w=Math.max(it.kind==="frame"?200:100,g.ow+dx);it.h=Math.max(it.kind==="frame"?140:70,g.oh+dy);el.style.width=it.w+"px";el.style.height=it.h+"px"}
    else{it.x=Math.round(g.ox+dx);it.y=Math.round(g.oy+dy);el.style.left=it.x+"px";el.style.top=it.y+"px";g.group.forEach(function(o){var oi=wbItem(o.id),oe=document.querySelector('.wbi[data-id="'+o.id+'"]');if(!oi||!oe)return;oi.x=Math.round(o.x+dx);oi.y=Math.round(o.y+dy);oe.style.left=oi.x+"px";oe.style.top=oi.y+"px"})}
    wbRedrawLinks()});
  var end=function(e){delete WB.pointers[e.pointerId];if(WB.pinch){if(Object.keys(WB.pointers).length<2)WB.pinch=null;return}var g=WB.drag;WB.drag=null;vp.classList.remove("panning");if(!g)return;if(g.pan)return;S.wbBusy=false;
    var it=wbItem(g.id);if(it&&g.moved){if(g.rz)wbSave(it.id,{w:Math.round(it.w),h:Math.round(it.h)});else{wbSave(it.id,{x:it.x,y:it.y});g.group.forEach(function(o){var oi=wbItem(o.id);if(oi)wbSave(oi.id,{x:oi.x,y:oi.y})})}}
    wbDraw();if(S.wbPending){S.wbPending=false;loadProject(true)}};
  vp.addEventListener("pointerup",end);vp.addEventListener("pointercancel",end);
}

/* ---------- Board PNG export & snapshots ---------- */
function wbRenderPNG(maxDim,bg){var items=wbItems(),solid=items.filter(function(i){return i.kind!=="link"});if(!solid.length)return null;
  var pad=48,x0=Math.min.apply(null,solid.map(function(i){return i.x}))-pad,y0=Math.min.apply(null,solid.map(function(i){return i.y}))-pad,x1=Math.max.apply(null,solid.map(function(i){return i.x+i.w}))+pad,y1=Math.max.apply(null,solid.map(function(i){return i.y+i.h}))+pad+40;
  var W=x1-x0,H=y1-y0,sc=Math.min(2,maxDim/Math.max(W,H));var c=document.createElement("canvas");c.width=Math.round(W*sc);c.height=Math.round(H*sc);var g=c.getContext("2d");g.scale(sc,sc);g.translate(-x0,-y0);
  g.fillStyle=bg||"#ffffff";g.fillRect(x0,y0,W,H);g.fillStyle="rgba(120,120,130,.22)";for(var gx=Math.ceil(x0/24)*24;gx<x1;gx+=24)for(var gy=Math.ceil(y0/24)*24;gy<y1;gy+=24){g.fillRect(gx-1,gy-1,2,2)}
  var rr=function(x,y,w,h,r){g.beginPath();g.moveTo(x+r,y);g.arcTo(x+w,y,x+w,y+h,r);g.arcTo(x+w,y+h,x,y+h,r);g.arcTo(x,y+h,x,y,r);g.arcTo(x,y,x+w,y,r);g.closePath()};
  var wrap=function(t,x,y,maxW,lh,maxH,font,color){g.font=font;g.fillStyle=color;var lines=[];String(t||"").split("\n").forEach(function(par){var words=par.split(/\s+/),line="";words.forEach(function(w){var test=line?line+" "+w:w;if(g.measureText(test).width>maxW&&line){lines.push(line);line=w}else line=test});lines.push(line)});lines.forEach(function(l,i){if((i+1)*lh<=maxH)g.fillText(l,x,y+i*lh)})};
  g.textBaseline="top";
  items.filter(function(i){return i.kind==="frame"}).forEach(function(f){var col=WBC[f.color]||"#bfdbfe";rr(f.x,f.y,f.w,f.h,16);g.globalAlpha=.25;g.fillStyle=col;g.fill();g.globalAlpha=1;g.lineWidth=2;g.strokeStyle=col;g.stroke();wrap(f.text||"Section",f.x+12,f.y+10,f.w-24,20,22,"700 16px Jakarta, Arial, sans-serif","#1d2430")});
  items.filter(function(i){return i.kind==="link"}).forEach(function(l){var a=wbItem(l.from_id),b=wbItem(l.to_id);if(!a||!b)return;var ac={x:a.x+a.w/2,y:a.y+a.h/2},bc={x:b.x+b.w/2,y:b.y+b.h/2};var e=function(r,t){var cx=r.x+r.w/2,cy=r.y+r.h/2,dx=t.x-cx,dy=t.y-cy,s2=Math.min((r.w/2+6)/Math.abs(dx||1e-9),(r.h/2+6)/Math.abs(dy||1e-9));return{x:cx+dx*s2,y:cy+dy*s2}};var p1=e(a,bc),p2=e(b,ac);
    g.strokeStyle="#4b5563";g.lineWidth=2.2;g.beginPath();g.moveTo(p1.x,p1.y);g.lineTo(p2.x,p2.y);g.stroke();var ang=Math.atan2(p2.y-p1.y,p2.x-p1.x);g.fillStyle="#4b5563";g.beginPath();g.moveTo(p2.x,p2.y);g.lineTo(p2.x-12*Math.cos(ang-.45),p2.y-12*Math.sin(ang-.45));g.lineTo(p2.x-12*Math.cos(ang+.45),p2.y-12*Math.sin(ang+.45));g.closePath();g.fill()});
  items.filter(function(i){return i.kind!=="frame"&&i.kind!=="link"}).sort(function(a,b){return(a.z||0)-(b.z||0)}).forEach(function(n){
    if(n.kind==="text"){wrap(n.text,n.x+6,n.y+4,n.w-12,26,Math.max(n.h,400),"600 20px Fraunces, Georgia, serif","#1d2430");return}
    g.save();g.shadowColor="rgba(0,0,0,.18)";g.shadowBlur=14;g.shadowOffsetY=6;rr(n.x,n.y,n.w,n.h,8);g.fillStyle=WBC[n.color]||"#fde68a";g.fill();g.restore();
    wrap(n.text,n.x+14,n.y+14,n.w-28,20,n.h-36,"500 15px Jakarta, Arial, sans-serif","#2b2620");
    if(n.votes>0){g.font="700 12px Jakarta, Arial";g.fillStyle="#be185d";g.fillText("♥ "+n.votes,n.x+n.w-44,n.y+n.h-20)}});
  var b=curBoard();g.font="600 13px Jakarta, Arial";g.fillStyle="#6b7280";g.fillText((P()?P().name+" · ":"")+(b?b.name:"")+" · "+new Date().toLocaleDateString(),x0+pad,y1-30);
  return{url:c.toDataURL("image/png"),w:c.width,h:c.height}}
function fileSafe(s){return String(s||"board").replace(/[^a-z0-9\-_ ]/gi,"").trim().replace(/\s+/g,"-").slice(0,60)||"board"}
function downloadPNG(url,name){try{if(window.AndroidBridge&&AndroidBridge.savePng){var ok=AndroidBridge.savePng(url.split(",")[1],name);toast(ok?"Saved to Pictures/Tandem":"Couldn't save to the phone");return}var a=document.createElement("a");a.href=url;a.download=name;document.body.appendChild(a);a.click();a.remove()}catch(e){}}
async function wbLeave(){if(!WB.dirty||!WB.boardId)return;WB.dirty=false;var r=wbRenderPNG(480);var b=curBoard();if(!b)return;var patch={thumbnail:r?r.url:null,updated_at:new Date().toISOString()};b.thumbnail=patch.thumbnail;b.updated_at=patch.updated_at;try{await DB.upd("boards",b.id,patch)}catch(e){}}
async function wbSavePNG(){var b=curBoard();var r=wbRenderPNG(DB.kind==="demo"?1000:1800);if(!r){toast("Add something to the board first");return}
  var name=fileSafe((P()?P().name+" - ":"")+b.name)+"-"+today()+".png";downloadPNG(r.url,name);
  var th=wbRenderPNG(480);try{await DB.ins("board_snapshots",{id:uuid(),project_id:P().id,board_id:b.id,name:b.name+" · "+new Date().toLocaleString(undefined,{month:"short",day:"numeric",hour:"numeric",minute:"2-digit"}),png:r.url,width:r.w,height:r.h,created_by:S.user.id});
    b.thumbnail=th.url;b.updated_at=new Date().toISOString();await DB.upd("boards",b.id,{thumbnail:th.url,updated_at:b.updated_at});WB.dirty=false;toast("PNG saved · added to Snapshots");buzz([10,30,10])}catch(e){toast("⚠ Snapshot not saved: "+e.message)}}
var snapCache=[];
function openSnaps(){var b=curBoard();modal('<div class="mh"><h3>Snapshots · '+esc(b.name)+'</h3><button class="x" data-a="close">×</button></div><p class="small muted">Every “Save PNG” is kept here as a record. Click one to view or download it.</p><div id="snaplist" class="snapgrid"><div class="empty small">Loading…</div></div>',function(){renderSnapList()},{drawer:true})}
async function renderSnapList(){var box=document.getElementById("snaplist");if(!box)return;try{snapCache=await DB.listBy("board_snapshots","board_id",WB.boardId)}catch(e){box.innerHTML='<div class="err">'+esc(e.message)+'</div>';return}
  box=document.getElementById("snaplist");if(!box)return;box.innerHTML=snapCache.length?snapCache.map(function(sn,i){return'<button class="snap" data-a="snapView" data-v="'+i+'"><img src="'+sn.png+'" alt=""><span class="sn"><b>'+esc(sn.name)+'</b><span class="small muted">'+(mname(sn.created_by)||"")+(sn.width?' · '+sn.width+'×'+sn.height:'')+'</span></span></button>'}).join(""):'<div class="empty small">No snapshots yet. Use <b>⬇ Save PNG</b> on the board.</div>'}
function snapView(i){var sn=snapCache[i];if(!sn)return;modal('<div class="mh"><h3>'+esc(sn.name)+'</h3><button class="x" data-a="close">×</button></div><div class="snapbig"><img src="'+sn.png+'" alt="Board snapshot"></div><div class="row" style="justify-content:space-between;margin-top:12px"><button class="btn danger small" id="sdel">Delete</button><div class="row"><button class="btn ghost" data-a="wbSnapsBack">Back</button><button class="btn" id="sdl">⬇ Download PNG</button></div></div>',function(m){m.querySelector("#sdl").onclick=function(){downloadPNG(sn.png,fileSafe(sn.name)+".png")};m.querySelector("#sdel").onclick=function(){confirmBox("Delete this snapshot?",async function(){try{await DB.del("board_snapshots",sn.id);toast("Snapshot deleted")}catch(e){toast("⚠ "+e.message)}openSnaps()},"Delete")}},{drawer:true})}
function newBoardModal(){modal('<div class="mh"><h3>New board</h3><button class="x" data-a="close">×</button></div><label class="f">Name</label><input class="i" id="nbn" placeholder="e.g. Kickoff brainstorm"><label class="f">Start from</label><div class="tplgrid">'+[["blank","Blank","An empty canvas"],["brainstorm","Brainstorm","Goals · Ideas · Risks · Questions"],["mindmap","Mind map","Project in the middle, branches around it"],["canvas","Project canvas","Problem → solution → success → next steps"],["ssc","Start · Stop · Continue","Quick retro or kickoff"]].map(function(t,i){return'<button class="tplcard'+(i===0?" on":"")+'" data-tpl="'+t[0]+'"><b>'+t[1]+'</b><span>'+t[2]+'</span></button>'}).join("")+'</div><label class="btn ghost small" style="display:inline-flex;align-items:center;gap:6px;margin-top:10px;cursor:pointer">⬆ Import board from file (.json)<input type="file" id="nbfile" accept=".json,application/json" hidden></label><div class="row sheet-actions" style="justify-content:flex-end;margin-top:14px"><button class="btn ghost" data-a="close">Cancel</button><button class="btn" id="nbok">Create board</button></div>',
  function(m){var tpl="blank";m.querySelectorAll("[data-tpl]").forEach(function(b){b.onclick=function(){tpl=b.dataset.tpl;m.querySelectorAll("[data-tpl]").forEach(function(x){x.classList.toggle("on",x===b)});var n=m.querySelector("#nbn");if(!n.value)n.placeholder=b.querySelector("b").textContent}});m.querySelector("#nbn").focus();
   m.querySelector("#nbfile").onchange=function(){var f=this.files[0];if(!f)return;var rd=new FileReader();rd.onload=function(){try{var j=JSON.parse(rd.result);closeModal();importBoard(j,m.querySelector("#nbn").value.trim())}catch(e){toast("⚠ That file isn\'t a Tandem board")}};rd.readAsText(f)};
   m.querySelector("#nbok").onclick=async function(){var name=m.querySelector("#nbn").value.trim()||(tpl==="blank"?"Untitled board":m.querySelector(".tplcard.on b").textContent);var b={id:uuid(),project_id:P().id,name:name,created_by:S.user.id,updated_at:new Date().toISOString()};closeModal();
    try{await DB.ins("boards",b);if(!S.d.boards)S.d.boards=[];if(!S.d.boards.some(function(x){return x.id===b.id}))S.d.boards.push(Object.assign({created_at:new Date().toISOString()},b));WB.boardId=b.id;S.lastKey=null;render();if(tpl!=="blank")setTimeout(function(){wbTemplate(tpl)},80)}catch(e){toast("⚠ "+e.message)}}})}
async function importBoard(j,nameOverride){var items=(j&&j.items)||[];if(!items.length){toast("⚠ No items in that file");return}
  var b={id:uuid(),project_id:P().id,name:(nameOverride||j.name||"Imported board").slice(0,120),created_by:S.user.id,updated_at:new Date().toISOString()};
  toast("Importing "+items.length+" items…");
  try{await DB.ins("boards",b);if(!S.d.boards)S.d.boards=[];S.d.boards.push(Object.assign({created_at:new Date().toISOString()},b));
    var ids={},z=0,rows=[];var ok={sticky:1,text:1,frame:1,link:1};
    items.filter(function(i){return ok[i.kind]&&i.kind!=="link"}).concat(items.filter(function(i){return i.kind==="link"})).forEach(function(i){
      var r={id:uuid(),project_id:P().id,board_id:b.id,kind:i.kind,x:+i.x||0,y:+i.y||0,w:+i.w||200,h:+i.h||140,text:String(i.text||"").slice(0,4000),color:WBC[i.color]?i.color:"yellow",votes:0,z:++z,created_by:S.user.id};
      if(i.kind==="link"){r.from_id=ids[i.from];r.to_id=ids[i.to];r.x=r.y=r.w=r.h=0;if(!r.from_id||!r.to_id)return}
      if(i.key)ids[i.key]=r.id;rows.push(r)});
    for(var k=0;k<rows.length;k++){await DB.ins("board_items",rows[k]);if(!S.d.board_items)S.d.board_items=[];S.d.board_items.push(Object.assign({created_at:new Date().toISOString()},rows[k]))}
    WB.boardId=b.id;S.lastKey=null;render();setTimeout(function(){try{wbFit()}catch(e){}},120);toast("Board imported")}catch(e){toast("⚠ "+e.message)}}
function boardMenu(id){var b=(D().boards||[]).filter(function(x){return x.id===id})[0];if(!b)return;modal('<div class="mh"><h3>'+esc(b.name)+'</h3><button class="x" data-a="close">×</button></div><label class="f">Rename</label><input class="i" id="rbn" value="'+esc(b.name)+'"><div class="row" style="justify-content:space-between;margin-top:14px"><button class="btn danger small" id="bdel">Delete board</button><div class="row"><button class="btn ghost" data-a="close">Cancel</button><button class="btn" id="bsave">Save</button></div></div>',
  function(m){m.querySelector("#bsave").onclick=function(){var v=m.querySelector("#rbn").value.trim();closeModal();if(v&&v!==b.name)act(function(){return DB.upd("boards",b.id,{name:v})},"Renamed")};
   m.querySelector("#bdel").onclick=function(){confirmBox("Delete “"+b.name+"” with all its notes and snapshots? This can't be undone.",function(){act(function(){return DB.del("boards",b.id)},"Board deleted")},"Delete")}})}

/* ---------- Rich text comments & @mentions ---------- */
var RT_OK={B:1,STRONG:1,I:1,EM:1,U:1,S:1,STRIKE:1,CODE:1,PRE:1,BLOCKQUOTE:1,UL:1,OL:1,LI:1,BR:1,P:1,DIV:1,A:1,SPAN:1};
function rtSanitize(html){var t=document.createElement("template");t.innerHTML=html;var walk=function(n){Array.prototype.slice.call(n.childNodes).forEach(function(c){
    if(c.nodeType===3)return;if(c.nodeType!==1){c.remove();return}var tag=c.tagName;
    if(/^(SCRIPT|STYLE|IFRAME|OBJECT|EMBED|NOSCRIPT|TEMPLATE|SVG|MATH|TITLE|HEAD|META|LINK|FORM|INPUT|BUTTON|TEXTAREA|SELECT)$/.test(tag)){c.remove();return}
    if(!RT_OK[tag]){walk(c);while(c.firstChild)c.parentNode.insertBefore(c.firstChild,c);c.remove();return}
    var keep={};if(tag==="A"){var h=c.getAttribute("href")||"";if(/^(https?:|mailto:)/i.test(h))keep.href=h}if(tag==="SPAN"&&c.classList.contains("mention")){keep["class"]="mention";keep["data-uid"]=c.getAttribute("data-uid")||""}
    Array.prototype.slice.call(c.attributes).forEach(function(a){c.removeAttribute(a.name)});for(var k in keep)c.setAttribute(k,keep[k]);if(tag==="A"){c.setAttribute("target","_blank");c.setAttribute("rel","noopener noreferrer")}
    if(tag==="SPAN"&&!keep["class"]){walk(c);while(c.firstChild)c.parentNode.insertBefore(c.firstChild,c);c.remove();return}walk(c)})};walk(t.content);return t.innerHTML.trim()}
function rtRender(body){if(/<\/?(b|i|u|s|p|div|br|ul|ol|li|span|a|strong|em|code|blockquote|pre)\b/i.test(body||""))return rtSanitize(body);return esc(body||"").replace(/\n/g,"<br>")}
function rtMentions(html){var ids=[];String(html).replace(/data-uid="([^"]+)"/g,function(_,u){if(ids.indexOf(u)<0)ids.push(u)});return ids}
function rtIsEmpty(el){return!el.textContent.trim()&&!el.querySelector(".mention")}
function rtEditorHTML(id,initial,ph){return'<div class="rte" data-rte="'+id+'"><div class="rtebar">'+[["bold","B","Bold (Ctrl+B)"],["italic","I","Italic (Ctrl+I)"],["underline","U","Underline"],["strikeThrough","S","Strikethrough"],["sep"],["insertUnorderedList","•","Bulleted list"],["insertOrderedList","1.","Numbered list"],["formatBlock:blockquote","❝","Quote"],["code","&lt;/&gt;","Code"],["link","🔗","Link"],["sep"],["mention","@","Tag someone"]].map(function(b){return b[0]==="sep"?'<span class="wbsep"></span>':'<button type="button" class="rtb rtb-'+b[0].replace(/[:]/g,"-")+'" data-cmd="'+b[0]+'" title="'+b[2]+'">'+b[1]+'</button>'}).join("")+'</div><div class="rtin" contenteditable="true" id="'+id+'" data-ph="'+esc(ph||"Write a comment… type @ to tag someone")+'">'+(initial||"")+'</div><div class="mentionpop" hidden></div></div>'}
function rtWire(root,onSubmit){var ed=root.querySelector(".rtin"),pop=root.querySelector(".mentionpop"),sel=0,matches=[],q=null;
  var exec=function(cmd){ed.focus();if(cmd==="link"){var u=prompt2("Link address (https://…)",function(u){if(!u)return;if(!/^(https?:|mailto:)/i.test(u))u="https://"+u;ed.focus();restore();document.execCommand("createLink",false,u)});return}
    if(cmd==="code"){var s=window.getSelection();var txt=s.toString();document.execCommand("insertHTML",false,"<code>"+esc(txt||"code")+"</code>&nbsp;");return}
    if(cmd==="mention"){document.execCommand("insertText",false,"@");check();return}
    if(cmd.indexOf("formatBlock:")===0){document.execCommand("formatBlock",false,cmd.split(":")[1]);return}document.execCommand(cmd,false,null)};
  var saved=null;var save=function(){var s=window.getSelection();if(s.rangeCount&&ed.contains(s.anchorNode))saved=s.getRangeAt(0).cloneRange()};var restore=function(){if(!saved)return;var s=window.getSelection();s.removeAllRanges();s.addRange(saved)};
  function prompt2(label,cb){save();var bar=root.querySelector(".rtlink");if(bar)bar.remove();bar=document.createElement("div");bar.className="rtlink";bar.innerHTML='<input class="i" placeholder="'+label+'"><button type="button" class="btn small">Add</button>';root.insertBefore(bar,ed.nextSibling);var i=bar.querySelector("input");i.focus();var go=function(){var v=i.value.trim();bar.remove();cb(v)};bar.querySelector("button").onclick=go;i.onkeydown=function(e){e.stopPropagation();if(e.key==="Enter"){e.preventDefault();go()}if(e.key==="Escape")bar.remove()}}
  root.querySelector(".rtebar").addEventListener("mousedown",function(e){if(e.target.closest(".rtb"))e.preventDefault()});
  root.querySelector(".rtebar").addEventListener("click",function(e){var b=e.target.closest(".rtb");if(b)exec(b.dataset.cmd)});
  function caretWord(){var s=window.getSelection();if(!s.rangeCount)return null;var r=s.getRangeAt(0);var n=r.startContainer;if(n.nodeType!==3||!ed.contains(n))return null;var before=n.textContent.slice(0,r.startOffset);var m=before.match(/(^|\s)@([^\s@]{0,30})$/);return m?{node:n,start:r.startOffset-m[2].length-1,end:r.startOffset,q:m[2].toLowerCase()}:null}
  function check(){var w=caretWord();if(!w){pop.hidden=true;q=null;return}q=w;matches=S.members.filter(function(m){return(m.name+" "+m.email).toLowerCase().indexOf(w.q)>=0}).slice(0,6);if(!matches.length){pop.hidden=true;return}sel=Math.min(sel,matches.length-1);
    pop.innerHTML=matches.map(function(m,i){return'<button type="button" class="mopt'+(i===sel?" on":"")+'" data-i="'+i+'">'+avatar(m.id,1)+'<b>'+esc(m.name)+'</b><span class="small muted">'+esc(m.email)+'</span></button>'}).join("");pop.hidden=false}
  function pick(i){var m=matches[i];if(!m||!q)return;var r=document.createRange();r.setStart(q.node,q.start);r.setEnd(q.node,q.end);r.deleteContents();var sp=document.createElement("span");sp.className="mention";sp.setAttribute("data-uid",m.id);sp.setAttribute("contenteditable","false");sp.textContent="@"+m.name.split(" ")[0];r.insertNode(sp);var sp2=document.createTextNode(" ");sp.parentNode.insertBefore(sp2,sp.nextSibling);var s=window.getSelection();var r2=document.createRange();r2.setStart(sp2,1);r2.collapse(true);s.removeAllRanges();s.addRange(r2);pop.hidden=true;q=null;buzz(8)}
  pop.addEventListener("mousedown",function(e){e.preventDefault();var b=e.target.closest(".mopt");if(b)pick(+b.dataset.i)});
  ed.addEventListener("input",function(){sel=0;check()});ed.addEventListener("keyup",function(e){if(["ArrowLeft","ArrowRight","Home","End"].indexOf(e.key)>=0)check()});ed.addEventListener("blur",function(){setTimeout(function(){pop.hidden=true},150)});
  ed.addEventListener("keydown",function(e){e.stopPropagation();if(!pop.hidden){if(e.key==="ArrowDown"){e.preventDefault();sel=(sel+1)%matches.length;check();return}if(e.key==="ArrowUp"){e.preventDefault();sel=(sel-1+matches.length)%matches.length;check();return}if(e.key==="Enter"||e.key==="Tab"){e.preventDefault();pick(sel);return}if(e.key==="Escape"){pop.hidden=true;return}}
    if(e.key==="Enter"&&(e.metaKey||e.ctrlKey)){e.preventDefault();onSubmit()}});
  ed.addEventListener("paste",function(e){var h=e.clipboardData&&e.clipboardData.getData("text/html"),t=e.clipboardData&&e.clipboardData.getData("text/plain");e.preventDefault();if(h)document.execCommand("insertHTML",false,rtSanitize(h));else document.execCommand("insertText",false,t||"")});
  return{get:function(){var h=rtSanitize(ed.innerHTML.replace(/&nbsp;/g," "));return h},clear:function(){ed.innerHTML=""},focus:function(){ed.focus()},el:ed}}
function commentCount(tid){return(D().task_comments||[]).filter(function(c){return c.task_id===tid}).length}

/* ---------- Notifications ---------- */
var NKIND={mention:["@","Mentions","Someone @mentions you"],assigned:["👤","Assignments","A task is assigned to you"],review:["👀","Reviews","A task is ready for your review"],comment:["💬","Comments","Someone comments on your task"],blocker:["⛔","Blockers","A teammate posts a blocker"],done:["✅","Completed","A task you created is finished"],due:["📅","Due dates","Your tasks due tomorrow, today or overdue"]};
var NOTIF={list:[],seen:lsGet("pmhub.notifSeen")||"",filter:"all",mode:"",dueSeen:{}};
try{NOTIF.dueSeen=JSON.parse(lsGet("pmhub.dueSeen")||"{}")}catch(e){}
function nMuted(){try{return JSON.parse(lsGet("pmhub.nmute")||"{}")}catch(e){return{}}}
function dueLabel(st){return st==="overdue"?"Overdue":st==="today"?"Due today":"Due tomorrow"}
function localDue(){var d=today(),t1=new Date(Date.now()+864e5).toISOString().slice(0,10);if(!S.d)return[];return D().tasks.filter(function(t){return t.assignee===S.user.id&&t.status!=="Done"&&t.due&&t.due<=t1}).map(function(t){return{task_id:t.id,project_id:t.project_id,title:t.title,due:t.due,state:t.due<d?"overdue":t.due===d?"today":"tomorrow"}})}
function dueItems(rows){var d=today();return(rows||[]).map(function(x){var id="due-"+x.task_id+"-"+d;return{id:id,kind:"due",title:dueLabel(x.state)+": "+x.title,body:x.due?("Due "+fmtDate(x.due)):"",project_id:x.project_id,task_id:x.task_id,created_at:d+"T00:00:00Z",read:!!NOTIF.dueSeen[id],state:x.state}})}
function nUnread(){var m=nMuted();return NOTIF.list.filter(function(n){return!n.read&&!m[n.kind]})}
function nBadge(){var c=nUnread().length;document.querySelectorAll(".bellcount").forEach(function(x){x.textContent=c>99?"99+":(c||"");x.hidden=!c})}
async function loadNotifs(){if(!S.user||!DB)return;var list=null;
  if(DB.notifs){try{list=await DB.notifs()}catch(e){list=null}}
  if(list){NOTIF.mode="full";list=list.map(function(n){return Object.assign({},n,{read:!!n.read_at})})}
  else{NOTIF.mode="mentions";var ms=[];try{ms=DB.mentionsFor?await DB.mentionsFor(S.user.id):[]}catch(e){}
    list=ms.filter(function(n){return n.user_id!==S.user.id}).map(function(n){return{id:n.id,kind:"mention",title:n.author+" mentioned you in “"+n.task_title+"”",body:(new DOMParser().parseFromString(rtRender(n.body),"text/html").body.textContent||"").slice(0,140),project_id:n.project_id,task_id:n.task_id,created_at:n.created_at,read:n.created_at<=NOTIF.seen}})}
  var due=null;if(DB.dueReminders){try{due=await DB.dueReminders()}catch(e){}}if(!due)due=localDue();
  NOTIF.list=dueItems(due).concat(list);nBadge();
  var top=nUnread().filter(function(n){return n.kind!=="due"})[0];if(top&&S.lastNotifTop!==top.id){if(S.lastNotifTop)nAlert(top);S.lastNotifTop=top.id}
  syncDevice()}
function nAlert(n){if(nMuted()[n.kind])return;toast((NKIND[n.kind]||["🔔"])[0]+" "+n.title);buzz(15);
  try{if(!hasNative()&&window.Notification&&Notification.permission==="granted"&&document.hidden){var x=new Notification(n.title,{body:n.body||"",icon:"icon.png",tag:n.id});x.onclick=function(){window.focus();openNotifItem(n.project_id,n.task_id);x.close()}}}catch(e){}}
function onLiveNotif(row){if(!row||row.user_id!==S.user.id)return;var n=Object.assign({},row,{read:false});if(NOTIF.list.some(function(x){return x.id===n.id}))return;NOTIF.list.splice(NOTIF.list.filter(function(x){return x.kind==="due"}).length,0,n);S.lastNotifTop=n.id;nBadge();nAlert(n);if(document.getElementById("nlist"))drawNotifs()}
function bellBtn(){var c=S.user?nUnread().length:0;return'<button class="iconbtn bell" data-a="notifs" aria-label="Notifications" title="Notifications">🔔<span class="bellcount"'+(c?'':' hidden')+'>'+(c||"")+'</span></button>'}
function drawNotifs(){var box=document.getElementById("nlist");if(!box)return;var m=nMuted(),f=NOTIF.filter;
  var xs=NOTIF.list.filter(function(n){return!m[n.kind]&&(f==="all"||(f==="unread"?!n.read:f==="due"?n.kind==="due":f==="mention"?n.kind==="mention":f==="work"?(n.kind==="assigned"||n.kind==="review"||n.kind==="done"||n.kind==="comment"||n.kind==="blocker"):true))});
  box.innerHTML=xs.length?xs.map(function(n){return'<button class="notif k-'+n.kind+(n.read?"":" unread")+(n.state?" s-"+n.state:"")+'" data-a="openNotif" data-p="'+(n.project_id||"")+'" data-v="'+(n.task_id||"")+'" data-n="'+n.id+'"><span class="nic">'+(NKIND[n.kind]||["🔔"])[0]+'</span><span class="grow"><b>'+esc(n.title)+'</b>'+(n.body?'<span class="small muted nb">'+esc(n.body)+'</span>':'')+'<span class="small muted">'+(n.kind==="due"?"Today":ago(n.created_at))+'</span></span><span class="nd"></span></button>'}).join(""):'<div class="empty small">'+(f==="unread"?"You're all caught up ✓":"Nothing here yet. Mentions, assignments, reviews, blockers and due dates will show up here.")+'</div>';
  document.querySelectorAll("[data-nf]").forEach(function(b){b.classList.toggle("on",b.dataset.nf===f)})}
function openNotifs(){var unr=nUnread().length;
  modal('<div class="mh"><h3>Notifications</h3><button class="x" data-a="close">×</button></div>'+
  '<div class="row between" style="margin-bottom:8px;gap:8px;flex-wrap:nowrap"><div class="chips nchips">'+[["all","All"],["unread","Unread"],["mention","Mentions"],["work","Tasks"],["due","Due"]].map(function(c){return'<button class="chip" data-nf="'+c[0]+'">'+c[1]+'</button>'}).join("")+'</div>'+
  '<button class="btn ghost small" id="nall"'+(unr?'':' disabled')+'>Mark all read</button></div>'+(NOTIF.mode==="mentions"&&DB.kind!=="demo"?'<div class="tip infobox small">Only mentions are shown. Run the notifications database update to get assignments, reviews, blockers and phone alerts.</div>':'')+
  '<div id="nlist"></div><button class="btn ghost small" style="margin-top:10px" data-a="settings">⚙ Notification settings</button>',function(m){
    m.querySelectorAll("[data-nf]").forEach(function(b){b.onclick=function(){NOTIF.filter=b.dataset.nf;drawNotifs()}});
    m.querySelector("#nall").onclick=function(){markAllRead();this.disabled=true;drawNotifs()};drawNotifs()},{drawer:true});
  NOTIF.seen=new Date().toISOString();lsSet("pmhub.notifSeen",NOTIF.seen);if(NOTIF.mode==="mentions"){NOTIF.list.forEach(function(n){if(n.kind==="mention")n.read=true})}}
function markRead(id){var n=NOTIF.list.filter(function(x){return x.id===id})[0];if(!n||n.read)return;n.read=true;if(n.kind==="due"){NOTIF.dueSeen[id]=1;saveDueSeen()}else if(NOTIF.mode==="full"&&DB.notifRead)DB.notifRead([id]).catch(function(){});nBadge()}
function markAllRead(){NOTIF.list.forEach(function(n){if(!n.read){n.read=true;if(n.kind==="due")NOTIF.dueSeen[n.id]=1}});saveDueSeen();if(NOTIF.mode==="full"&&DB.notifAllRead)DB.notifAllRead().catch(function(){});nBadge()}
function saveDueSeen(){var d=today(),o={};for(var k in NOTIF.dueSeen)if(k.slice(-10)===d)o[k]=1;NOTIF.dueSeen=o;lsSet("pmhub.dueSeen",JSON.stringify(o))}
function openNotifItem(pid,tid){var go=function(){S.tab=tid?"board":"sprint";if(!tid)S.sub.sprint="standup";S.lastKey=null;render();if(tid)setTimeout(function(){editTask(tid)},120)};if(pid&&pid!==S.cur&&S.projects.some(function(x){return x.id===pid})){S.cur=pid;lsSet("pmhub.cur",pid);S.d=null;loadProject().then(go)}else go()}
window.TandemOpen=function(pid,tid){if(!S.user){setTimeout(function(){window.TandemOpen(pid,tid)},500);return}closeModal();openNotifItem(pid||"",tid||"")};
/* phone delivery: the Android app polls notif_feed with its own private token */
function syncDevice(){try{if(!window.AndroidBridge||!AndroidBridge.notifyToken||NOTIF.mode!=="full"||!DB.registerDevice)return;var tok=AndroidBridge.notifyToken();var c=DB.conn();var key=S.user.id+"|"+tok;
  AndroidBridge.notifyConfig(JSON.stringify({mute:nMuted()}));
  if(lsGet("pmhub.devReg")===key)return;DB.registerDevice(tok).then(function(){AndroidBridge.notifyRegister(c.url,c.key);lsSet("pmhub.devReg",key)}).catch(function(){})}catch(e){}}
setInterval(loadNotifs,60*1000);window.loadNotifsNow=function(){if(S.user)loadNotifs()};
document.addEventListener("visibilitychange",function(){if(!document.hidden&&S.user)loadNotifs()});

/* ---------- Quick assign ---------- */
function quickAssign(tid){var t=taskById(tid);if(!t)return;modal('<div class="mh"><h3>Assign “'+esc(t.title)+'”</h3><button class="x" data-a="close">×</button></div><div class="alist">'+S.members.map(function(m){return'<button class="aopt'+(t.assignee===m.id?" on":"")+'" data-a="setAssignee" data-t="'+tid+'" data-v="'+m.id+'">'+avatar(m.id)+'<span class="grow"><b>'+esc(m.name)+(m.id===S.user.id?" (me)":"")+'</b><br><span class="small muted">'+D().tasks.filter(function(x){return x.assignee===m.id&&x.status!=="Done"}).length+' open tasks</span></span>'+(t.assignee===m.id?'✓':'')+'</button>'}).join("")+'<button class="aopt'+(!t.assignee?" on":"")+'" data-a="setAssignee" data-t="'+tid+'" data-v=""><span class="av" style="background:var(--muted)">–</span><span class="grow"><b>Unassigned</b></span>'+(!t.assignee?'✓':'')+'</button></div>')}

/* ---------- Plan ---------- */
function renderPlan(){
  var p=P(),c=p.charter||{},sub=S.sub.plan||"charter";var h=subtabs("plan",[["charter","Charter"],["people","Stakeholders"],["risks","Risks"],["decisions","Decisions"]],"charter");
  if(sub==="charter"){var fld=function(k,label,hint,ta){return'<label class="f">'+label+'</label>'+(ta?'<textarea class="i" data-ch="'+k+'">'+esc(c[k]||"")+'</textarea>':'<input class="i" data-ch="'+k+'" '+(k==="deadline"?'type="date"':'')+' value="'+esc(c[k]||"")+'">')+(hint?'<div class="hint">'+hint+'</div>':'')};
    h+='<div class="card"><h3>Project charter</h3><p class="small muted">One page you both agree on. Point back to it whenever scope questions come up.</p><label class="f">Project name</label><input class="i" id="pname" value="'+esc(p.name)+'">'+
    fld("why","Why are we doing this?","The problem or opportunity, in one or two sentences.",1)+fld("goal","SMART goal","Specific, measurable, achievable, relevant, time-bound. Include a number and a date.",1)+
    ((c.goal||"")&&!/\d/.test(c.goal)?'<div class="tip warnbox small">No number in the goal yet. How will you measure it?</div>':'')+
    fld("scopeIn","In scope","What you WILL deliver.",1)+fld("scopeOut","Out of scope","What you will NOT do. This is your shield against scope creep.",1)+fld("success","Success criteria","How the sponsor will judge success. Make it observable.",1)+
    '<div class="grid2"><div>'+fld("deadline","Deadline","")+'</div><div>'+fld("sponsor","Sponsor (final decision-maker)","")+'</div></div>'+
    '<div class="row" style="margin-top:12px"><button class="btn" data-a="saveCharter">Save charter</button><button class="btn ghost" data-a="copyCharter">Copy as text</button></div></div>'}
  if(sub==="people"){h+='<div class="card"><h3>Stakeholders & RACI</h3><p class="small muted">R = does the work · A = owns the outcome (exactly one) · C = consulted before · I = informed after</p>'+
    (D().stakeholders.length?'<div class="tscroll"><table class="t"><tr><th>Name</th><th>Role</th><th>RACI</th><th></th></tr>'+D().stakeholders.map(function(x){return'<tr><td>'+esc(x.name)+'</td><td>'+esc(x.role)+'</td><td><b>'+esc(x.raci)+'</b></td><td><button class="btn ghost small" data-a="delRow" data-t="stakeholders" data-v="'+x.id+'" aria-label="Remove">×</button></td></tr>'}).join("")+'</table></div>':'<p class="muted small">No stakeholders yet. Who is affected by this project, or has a say in it?</p>')+
    '<div class="grid2" style="margin-top:8px"><div><label class="f">Name</label><input class="i" id="pnm"></div><div><label class="f">Role</label><input class="i" id="prl" placeholder="Sponsor, mentor, user…"></div><div><label class="f">RACI</label><select class="i" id="prc"><option>R</option><option>A</option><option>C</option><option selected>I</option></select></div></div><button class="btn" style="margin-top:10px" data-a="addPerson">Add stakeholder</button></div>'}
  if(sub==="risks"){var rs=D().risks.slice().sort(function(a,b){return riskScore(b)-riskScore(a)});
    h+='<div class="card"><h3>Risk register</h3><p class="small muted">Score = probability × impact (1–5 each). 12+ high: act now · 6–11 medium: plan · ≤5 low: watch</p>'+
    (rs.length?rs.map(function(r){var s=riskScore(r);return'<div class="lrow" data-a="editRisk" data-v="'+r.id+'" style="cursor:pointer"><span class="score big '+riskCls(s)+'">'+s+'</span><div class="grow"><div class="lt">'+esc(r.title)+(r.status!=="Open"?' <span class="pill">'+esc(r.status)+'</span>':'')+'</div><div class="small muted">'+(r.mitigation?'🛡 '+esc(r.mitigation):'<span class="overdue">No mitigation yet</span>')+' · '+(r.owner_name?esc(r.owner_name):'<span class="overdue">no owner</span>')+'</div></div><span class="muted">›</span></div>'}).join(""):'<p class="muted small">No risks yet. Ask: what could delay this, cost more, or upset someone?</p>')+
    '<button class="btn" style="margin-top:10px" data-a="editRisk" data-v="">+ Add risk</button></div>'}
  if(sub==="decisions"){h+='<div class="card"><h3>Decision log</h3><p class="small muted">Record what was decided and why, so you don\'t have the same debate twice.</p><label class="f">Decision</label><input class="i" id="dd"><label class="f">Why</label><textarea class="i" id="dw"></textarea><label class="f">Alternatives considered</label><input class="i" id="da"><label class="f">Decided by</label><input class="i" id="db" value="'+esc(S.user.name)+'"><button class="btn" style="margin-top:10px" data-a="addDecision">Log decision</button></div>'+
    D().decisions.slice().reverse().map(function(d){return'<div class="card small"><div class="row between"><b>'+esc(d.decision)+'</b><span class="muted">'+fmtDate(d.created_at)+'</span></div>'+(d.why?'<div><span class="muted">Why:</span> '+esc(d.why)+'</div>':'')+(d.alternatives?'<div><span class="muted">Alternatives:</span> '+esc(d.alternatives)+'</div>':'')+'<div><span class="muted">By:</span> '+esc(d.decided_by)+'</div></div>'}).join("")}
  return h;
}
function editRisk(id){var p=P();var r=id?D().risks.filter(function(x){return x.id===id})[0]:{title:"",prob:3,impact:3,mitigation:"",owner_name:"",status:"Open"};
  var sel=function(i,v){return'<select class="i" id="'+i+'">'+[1,2,3,4,5].map(function(n){return'<option'+(n==v?" selected":"")+'>'+n+'</option>'}).join("")+'</select>'};
  modal('<div class="mh"><h3>'+(id?"Edit risk":"New risk")+'</h3><button class="x" data-a="close">×</button></div><label class="f">What might happen?</label><input class="i" id="rt" value="'+esc(r.title)+'"><div class="grid2"><div><label class="f">Probability (1 rare → 5 almost certain)</label>'+sel("rp",r.prob)+'</div><div><label class="f">Impact (1 minor → 5 severe)</label>'+sel("ri",r.impact)+'</div></div><div class="tip small" id="rsc"></div><label class="f">Mitigation (avoid · reduce · transfer · accept + plan B)</label><textarea class="i" id="rm">'+esc(r.mitigation)+'</textarea><div class="grid2"><div><label class="f">Owner</label><input class="i" id="ro" list="mlist" value="'+esc(r.owner_name)+'"><datalist id="mlist">'+S.members.map(function(m){return'<option value="'+esc(m.name)+'">'}).join("")+'</datalist></div><div><label class="f">Status</label><select class="i" id="rs">'+["Open","Mitigated","Happened","Closed"].map(function(x){return'<option'+(x===r.status?" selected":"")+'>'+x+'</option>'}).join("")+'</select></div></div><div class="row between" style="margin-top:14px">'+(id?'<button class="btn danger small" id="rdel">Delete</button>':'<span></span>')+'<div class="row"><button class="btn ghost" data-a="close">Cancel</button><button class="btn" id="rsave">Save</button></div></div>',
  function(m){var upd=function(){var s=m.querySelector("#rp").value*m.querySelector("#ri").value;m.querySelector("#rsc").innerHTML='Score <span class="score '+riskCls(s)+'">'+s+'</span> '+(s>=12?"High: act now.":s>=6?"Medium: plan a response.":"Low: note and watch.")};upd();m.querySelector("#rp").onchange=upd;m.querySelector("#ri").onchange=upd;
   m.querySelector("#rsave").onclick=function(){var tt=m.querySelector("#rt").value.trim();if(!tt){toast("Describe the risk");return}var row={title:tt,prob:+m.querySelector("#rp").value,impact:+m.querySelector("#ri").value,mitigation:m.querySelector("#rm").value.trim(),owner_name:m.querySelector("#ro").value.trim(),status:m.querySelector("#rs").value};closeModal();if(id)act(function(){return DB.upd("risks",id,row)});else{row.project_id=p.id;act(function(){return DB.ins("risks",row)},"Risk added")}};
   var d=m.querySelector("#rdel");if(d)d.onclick=function(){closeModal();act(function(){return DB.del("risks",id)})}})}

/* ---------- Coach ---------- */
function renderCoach(){
  var sub=S.sub.coach||"health";var h=subtabs("coach",[["health","Health check"],["report","Status report"],["people","Workload"]],"health");
  if(sub==="health"){var hs=health(),r=rag(),order={hi:0,md:1,lo:2};hs.sort(function(a,b){return order[a.sev]-order[b.sev]});
    h+='<div class="dgrid">';h+='<div class="card"><div class="row between"><div><h3 style="margin:0">Project health</h3><div class="small muted">'+progress()+'% of planned points done</div></div><span class="rag '+r+'">'+({G:"Green",A:"Amber",R:"Red"})[r]+'</span></div><div class="bar" style="margin-top:10px"><i style="width:'+progress()+'%"></i></div></div>';
    h+='<div class="card"><h3>What a senior PM would flag</h3>'+(hs.length?hs.map(function(x){return'<div class="issue"><span class="dot '+x.sev+'"></span><div class="grow"><div>'+esc(x.msg)+'</div><div class="row" style="margin-top:4px"><button class="btn ghost small" data-a="goto" data-v="'+x.tab+'" data-s="'+(x.sub||"")+'">Fix it</button><button class="btn ghost small" data-a="goto" data-v="guide" data-s="'+x.guide+'">Why it matters</button></div></div></div>'}).join(""):'<div class="issue allgood">'+((theme!=="classic"&&theme!=="pro")?'<span class="mini">'+MASCOT[theme]+'</span>':'<span class="dot ok"></span>')+'<div>'+TH().allgood+'</div></div>')+'</div></div>'}
  if(sub==="report"){var p=P();h+='<div class="card"><h3>Weekly status report</h3><p class="small muted">Built from the board, sprint and risks. Add your asks, then copy and send.</p><label class="f">Asks / decisions needed</label><textarea class="i" id="asks" placeholder="e.g. Approve a budget for the venue by Friday">'+esc(p.asks||"")+'</textarea><pre class="report" id="rep">'+esc(reportText())+'</pre><div class="row"><button class="btn" data-a="copyReport">Copy report</button><button class="btn ghost" data-a="saveAsks">Save asks</button></div></div>'}
  if(sub==="people"){var t=D().tasks;h+='<div class="card"><h3>Workload</h3><p class="small muted">Open work per person. Uneven load is a risk; rebalance at sprint planning.</p>'+S.members.map(function(m){var mine=D().tasks.filter(function(x){return x.assignee===m.id});var c=function(st){return mine.filter(function(x){return x.status===st}).length};var pts=mine.filter(function(x){return x.status!=="Done"&&x.status!=="Backlog"}).reduce(function(a,x){return a+(+x.points||0)},0);var d7=mine.filter(function(x){return x.status==="Done"&&x.done_at>=addDays(-7)}).length;var mx=Math.max(1,pts);return'<div class="lrow">'+avatar(m.id)+'<div class="grow"><div class="lt">'+esc(m.name)+' <span class="small muted">'+pts+' open pts</span></div><div class="wl"><span>To Do <b>'+c("To Do")+'</b></span><span>Doing <b>'+c("In Progress")+'</b></span><span>Review <b>'+c("Review")+'</b></span><span>Done 7d <b>'+d7+'</b></span></div></div></div>'}).join("")+'</div>'}
  return h;
}
function reportText(){var p=P(),r=rag(),RN={G:"GREEN, on track",A:"AMBER, at risk (plan in place)",R:"RED, needs help or a decision"}[r];
  var done=D().tasks.filter(function(t){return t.status==="Done"&&t.done_at>=addDays(-7)});
  var next=D().tasks.filter(function(t){return t.status==="To Do"||t.status==="In Progress"||t.status==="Review"}).sort(function(a,b){return PRI.indexOf(a.priority||"Wont")-PRI.indexOf(b.priority||"Wont")}).slice(0,5);
  var bl=D().tasks.filter(function(t){return isBlocked(t)&&t.status!=="Backlog"}),od=D().tasks.filter(isOverdue);
  var stb=D().standups.filter(function(s){return s.blockers&&s.day>=addDays(-3)});
  var rk=D().risks.filter(function(x){return x.status==="Open"}).sort(function(a,b){return riskScore(b)-riskScore(a)}).slice(0,3);var sp=activeSprint();var L=[];
  L.push("PROJECT: "+p.name);L.push("Week of "+fmtDate(today())+((p.charter||{}).deadline?" · Deadline "+fmtDate(p.charter.deadline):""));L.push("");
  L.push("STATUS: "+RN);L.push("Progress: "+progress()+"% of planned work done"+(sp?" · "+sp.name+" goal: "+(sp.goal||"(none)"):""));L.push("");
  L.push("DONE THIS WEEK");L.push(done.length?done.map(function(t){return"• "+t.title+(t.assignee?" ("+mname(t.assignee)+")":"")}).join("\n"):"• (nothing completed)");L.push("");
  L.push("NEXT UP");L.push(next.length?next.map(function(t){return"• "+t.title+(t.assignee?" ("+mname(t.assignee)+")":"")+(t.due?" – due "+fmtDate(t.due):"")}).join("\n"):"• (no planned work)");L.push("");
  L.push("BLOCKERS & DELAYS");var b=[];bl.forEach(function(t){b.push("• Blocked: "+t.title)});od.forEach(function(t){b.push("• Overdue: "+t.title+" (was due "+fmtDate(t.due)+")")});stb.forEach(function(s){b.push("• "+mname(s.user_id)+": "+s.blockers)});L.push(b.length?b.join("\n"):"• None");L.push("");
  L.push("TOP RISKS");L.push(rk.length?rk.map(function(x){return"• ["+riskScore(x)+"] "+x.title+" → "+(x.mitigation||"no mitigation yet")}).join("\n"):"• None logged");L.push("");
  L.push("ASKS");var asks=(document.getElementById("asks")||{}).value;if(asks==null)asks=p.asks||"";L.push(asks.trim()?asks.trim().split("\n").map(function(a){return"• "+a}).join("\n"):"• None this week");
  return L.join("\n")}

/* ---------- Guide (best practices) ---------- */
/* ---------- term help ("?" tips) ---------- */
var TERMS={
 "backlog":["Backlog","Every task that's been captured but isn't being worked on yet, in priority order. Ideas become tasks here first.","Pull from the top during sprint planning."],
 "to do":["To Do","Work picked for now that hasn't started yet.","Only move a task here if someone will start it soon."],
 "in progress":["In Progress","Someone is actively working on it right now.","Keep this column small. See WIP limit."],
 "review":["Review","Finished by the owner and waiting for the other person to check it against the acceptance criteria.","Reviewing a teammate's work comes before starting anything new."],
 "to review":["To review","Tasks your teammate finished that are waiting for you to check.","Review first, then start new work."],
 "done":["Done","Finished and checked. Every acceptance criterion is met.","If it isn't checked, it isn't done."],
 "wip":["WIP limit","Work In Progress limit: the most tasks allowed in In Progress at the same time.","Hit the limit? Finish or review something before you start new work."],
 "in progress ":["WIP limit","",""],
 "sprint backlog":["Sprint backlog","The tasks the two of you committed to finishing this sprint.","New requests go to the main backlog, not here, unless they break the sprint goal."],
 "sprint goal":["Sprint goal","One sentence that says what will be true at the end of the sprint.","Example: \"Bert can run a full mock interview on his own.\""],
 "sprint planning":["Sprint planning","A short meeting at the start of a sprint to choose the goal and pull tasks from the backlog.","Plan only as many points as your usual velocity."],
 "sprint calendar":["Sprint calendar","The dates of each sprint, with its planning and retro meetings.",""],
 "past sprints":["Past sprints","Closed sprints and how many points each one finished.","This history is what velocity is based on."],
 "sprint":["Sprint","A fixed time box, usually 1–2 weeks, where you commit to a small set of tasks and finish them.","Sprints end on schedule even when work is left over. Unfinished tasks go back to the backlog."],
 "story points":["Story points","A relative size for a task that combines effort, complexity and uncertainty. It is not hours.","Use 1, 2, 3, 5, 8, 13. Anything over 8 should be split."],
 "points":["Story points","A relative size for a task (1, 2, 3, 5, 8, 13). Bigger means more effort or more unknowns.",""],
 "priority":["Priority (MoSCoW)","Must: the project fails without it. Should: important, but there's a workaround. Could: nice if there's time. Won't: not this time, and agreed.","Do Musts first. If everything is a Must, nothing is."],
 "must":["Must","The project fails or slips without this.","Ask: if this were the only thing missing, would we delay?"],
 "should":["Should","Important, but there's a workaround if it slips.",""],
 "could":["Could","Nice to have if there's time left over.",""],
 "won't":["Won't (this time)","Agreed to leave out of this round. Writing it down stops scope creep.",""],
 "acceptance criteria":["Acceptance criteria","A checklist that proves the task is done. The reviewer checks against it.","Example: \"Venue booked · deposit paid · confirmation shared\"."],
 "blocked by":["Blocked by (dependency)","This task can't start until another task is finished.","Chains of dependencies make up the critical path."],
 "blockers":["Blocker","Anything stopping your work: waiting on someone, missing info, a tool that's broken.","Raise it in today's standup. Helping unblock your teammate comes first."],
 "assignee":["Assignee","The one person responsible for getting the task done.","Exactly one per task. \"We'll both do it\" usually means nobody will."],
 "due date":["Due date","When the task needs to be finished.","Set it a little before the real deadline to leave a buffer."],
 "status":["Status","Where a task is in the flow: Backlog → To Do → In Progress → Review → Done.",""],
 "burndown":["Burndown chart","Points left in the sprint, plotted day by day. The dashed line is the ideal pace.","Above the line means behind. Talk about it at standup instead of waiting for the retro."],
 "velocity":["Velocity","Average story points the team finishes per sprint.","Use it to decide how much to plan next sprint, not to compare people."],
 "standups":["Standup","A daily 2-minute check-in: what I did yesterday, what I'm doing today, any blockers.","Blockers are the point. Raise them early."],
 "standup":["Standup","A daily 2-minute check-in: what I did yesterday, what I'm doing today, any blockers.",""],
 "retros":["Retrospective","A short meeting at the end of a sprint to improve how you work together (not to blame anyone).","End with 1–3 actions, each with an owner."],
 "retrospective":["Retrospective","A short meeting at the end of a sprint to improve how you work together.","No actions means no retro."],
 "charter":["Project charter","A one-page agreement on why the project exists, what's in and out of scope, who decides, and what success looks like.","Settles scope arguments before they start."],
 "project charter":["Project charter","A one-page agreement on why, what, who decides, and what done looks like.",""],
 "stakeholders":["Stakeholders & RACI","People affected by or with a say in the project. RACI shows each person's role: Responsible, Accountable, Consulted, Informed.","Exactly one Accountable per decision."],
 "raci":["RACI","R = does the work · A = owns the outcome and makes the final call · C = asked before deciding · I = told after.",""],
 "risks":["Risk","Something that might go wrong but hasn't yet. Score = probability × impact.","12 or more: act now. A risk that happens becomes an issue."],
 "risk register":["Risk register","The list of risks, each with a score, an owner and a plan.","Review it at every sprint planning."],
 "probability":["Probability","How likely the risk is: 1 = rare, 5 = almost certain.",""],
 "impact":["Impact","How bad it would be if it happened: 1 = minor, 5 = severe.",""],
 "mitigation":["Mitigation","Your response to a risk: avoid it, reduce it, transfer it, or accept it with a plan B.",""],
 "decisions":["Decision log","A record of what was decided, by whom, and why.","Stops you from having the same debate twice."],
 "decision log":["Decision log","A record of what was decided, by whom, and why.",""],
 "health check":["Health check","Tandem's automatic review of your project, flagging what an experienced PM would notice: overloaded WIP, Musts without dates, risks with no owner.",""],
 "what a senior pm would flag":["Health check","Problems an experienced project manager would notice right away. Tap Fix it to jump there.",""],
 "status report":["Status report","A weekly update: Green = on track, Amber = at risk with a plan, Red = off track and needs help.","Always end with a clear ask."],
 "weekly status report":["Status report","Green = on track, Amber = at risk with a plan, Red = needs help. Report Amber early.",""],
 "workload":["Workload","How much open work each person has.","Uneven load is a risk. Rebalance at sprint planning."],
 "due today":["Due today","Tasks assigned to you that are due today.",""],
 "overdue":["Overdue","Your tasks that are past their due date.","Either finish them or agree on a new date. Don't leave them silently late."],
 "templates":["Templates","Ready-made brainstorming layouts, like Start·Stop·Continue or an impact/effort grid.",""],
 "snapshots":["Snapshot","A saved picture of a board at a point in time, kept as a record.",""]
};
delete TERMS["in progress "];
var TERMKEYS=Object.keys(TERMS).sort(function(a,b){return b.length-a.length});
function tipsOn(){return lsGet("pmhub.tips")!=="off"}
function termFor(txt){var t=(txt||"").toLowerCase().replace(/[\u{1F300}-\u{1FAFF}☀-➿]/gu,"").replace(/[·().,:…!?]|\d+/g," ").replace(/\s+/g," ").trim();if(!t)return null;
  if(TERMS[t])return t;for(var i=0;i<TERMKEYS.length;i++){var k=TERMKEYS[i];if(t.indexOf(k)===0&&(t.length===k.length||t.charAt(k.length)===" "))return k}return null}
function annotateTerms(root){if(!root)return;
  root.querySelectorAll(".pill").forEach(function(el){var k=termFor(el.textContent);if(k&&!el.title)el.title=TERMS[k][0]+": "+TERMS[k][1]});
  if(!tipsOn())return;
  root.querySelectorAll("h3,label.f,.colh>span:first-child,.subtabs button,.kl,.colnav button").forEach(function(el){
    if(el.querySelector(".qt")||el.closest(".task,.guide,.gl,.wbwrap"))return;var k=termFor(el.textContent);if(!k)return;
    el.insertAdjacentHTML("beforeend",'<span class="qt" role="button" tabindex="0" data-a="tip" data-v="'+k+'" aria-label="What is '+esc(TERMS[k][0])+'?">?</span>')})}
function closeTip(){var o=document.getElementById("tippop");if(o)o.remove()}
function showTip(el,k){closeTip();var d=TERMS[k];if(!d)return;var pop=document.createElement("div");pop.id="tippop";pop.setAttribute("role","tooltip");
  pop.innerHTML='<b>'+esc(d[0])+'</b><p>'+esc(d[1])+'</p>'+(d[2]?'<p class="tipx">💡 '+esc(d[2])+'</p>':'')+'<button class="tipmore" data-a="goto" data-v="guide" data-s="gloss">Open glossary →</button>';
  pop.dataset.t=Date.now();document.body.appendChild(pop);var r=el.getBoundingClientRect(),w=pop.offsetWidth,h=pop.offsetHeight;
  var x=Math.max(8,Math.min(window.innerWidth-w-8,r.left+r.width/2-w/2)),y=r.bottom+8;if(y+h>window.innerHeight-8)y=Math.max(8,r.top-h-8);
  pop.style.left=x+"px";pop.style.top=y+"px"}
document.addEventListener("click",function(e){if(!e.target.closest("#tippop,.qt"))closeTip()},true);
window.addEventListener("scroll",function(){var o=document.getElementById("tippop");if(o&&Date.now()-(+o.dataset.t||0)>400)closeTip()},true);
document.addEventListener("keydown",function(e){if(e.key==="Escape")closeTip();if((e.key==="Enter"||e.key===" ")&&e.target.classList&&e.target.classList.contains("qt")){e.preventDefault();e.target.click()}});

var GUIDE=[
["rhythm","How we work: the weekly rhythm",'<p>A light, repeatable routine beats a perfect plan.</p><ul><li><b>Monday, 20 min:</b> sprint planning. Agree on one sprint goal, then pull tasks from the backlog up to your average velocity, Musts first.</li><li><b>Every day, 2 min:</b> post a standup (done · today · blockers) and move your cards.</li><li><b>Friday, 15 min:</b> open Coach, fix the red items, copy the status report and send it to whoever needs it.</li><li><b>End of sprint, 20 min:</b> close the sprint, run a retro, and assign owners to the action items.</li></ul>'],
["charter","Charter & SMART goals",'<p>The charter is a one-page agreement on <b>why</b>, <b>what</b>, <b>who decides</b>, and <b>what "done" means</b>. It ends scope arguments before they start.</p><ul><li>A SMART goal has a number and a date.</li><li>Write what is <b>out of scope</b>. That\'s your shield against scope creep.</li><li>Success criteria must be observable: "both of us rate it 4/5", not "it goes well".</li></ul><div class="ex">Weak: "Prepare for interviews."<br>SMART: "Complete 8 mock interviews and 40 practice problems by Dec 15."</div><p>Scope, time and cost are linked. When someone adds scope, say what moves: the date, the budget, or other scope.</p>'],
["tasks","Writing good tasks",'<ul><li>Start with a <b>verb</b> and make "done" obvious: "Book venue with deposit paid", not "Venue".</li><li>One <b>assignee</b> per task. "We\'ll both do it" means nobody will.</li><li>Split anything over 8 points, or anything that takes more than 2–3 days.</li><li>Write <b>acceptance criteria</b>, one check per line. They are what Review checks against.</li><li>Ask questions in the task\'s <b>comments</b>, not in chat, so the context stays with the work.</li></ul><div class="ex">User-story style: As a <b>study-group member</b>, I want <b>a shared notes doc</b> so that <b>I can catch up if I miss a session</b>.</div>'],
["prio","Prioritizing (MoSCoW)",'<ul><li><b>Must</b>: the project fails without it. Test: "If this is the only thing missing, do we cancel or delay?"</li><li><b>Should</b>: important, but there\'s a workaround.</li><li><b>Could</b>: nice if there\'s time.</li><li><b>Won\'t (this time)</b>: agreed to skip, written down so it stops coming back.</li></ul><p>Keep Musts at <b>60% or less</b> of the work. That\'s your buffer when things go wrong.</p>'],
["estimate","Estimating & velocity",'<p>Estimate by <b>comparison</b>, not by hours. Story points combine effort, complexity and uncertainty.</p><ul><li>Use 1, 2, 3, 5, 8, 13, 21. The gaps grow because big work is less certain.</li><li>Pick a well-known small task as your "2" and compare everything to it.</li><li>Disagree on a number? The high and low estimators explain why. That\'s where hidden risks show up.</li><li><b>Velocity</b> = points actually finished per sprint. Plan the next sprint near the average of the last 3. Never plan on hope.</li></ul>'],
["schedule","Dependencies, deadlines & the critical path",'<ul><li>Mark <b>Blocked by</b> on a task when it can\'t start until another finishes.</li><li>The <b>critical path</b> (orange edge) is the longest chain of dependent work. A delay there delays the whole project.</li><li>Set Musts\' due dates a few days before the real deadline. Buffers are planning, not pessimism.</li><li>Overdue? Re-plan the date honestly and tell people. Don\'t quietly slip.</li></ul>'],
["flow","Flow: WIP limits & Review",'<ul><li><b>Stop starting, start finishing.</b> The WIP limit caps work in progress across the team.</li><li>Hit the limit? Help finish or review something before pulling new work.</li><li><b>Review</b> means the other person checks the work against its acceptance criteria. Reviews come before new work.</li><li>Three or more tasks in progress for one person means too much context switching.</li></ul>'],
["sprint","Sprints",'<ul><li>1–2 weeks, with <b>one sentence</b> sprint goal: what will be true at the end?</li><li>Commit to what your velocity supports. Protect the sprint: new requests go to the backlog unless they truly break the goal.</li><li>At the end, close the sprint. Unfinished work goes back to the backlog and velocity is recorded automatically.</li></ul>'],
["standup","Standups & blockers",'<ul><li>Three lines: done yesterday · doing today · <b>blockers</b>.</li><li>Blockers are the point. Raised on day 1 they cost an hour; found on day 9 they cost the sprint.</li><li>When the other person posts a blocker, helping them is today\'s top priority.</li></ul>'],
["raci","Stakeholders & RACI",'<ul><li><b>R</b>esponsible: does the work. <b>A</b>ccountable: owns the outcome and makes the final call. <b>C</b>onsulted: input before decisions. <b>I</b>nformed: told after.</li><li>Exactly <b>one A</b> per project or decision.</li><li>List stakeholders at the start. A forgotten stakeholder is the classic late surprise.</li></ul>'],
["risk","Risks & decisions",'<ul><li>A <b>risk</b> might happen; an <b>issue</b> already has. Manage risks so they don\'t become issues.</li><li>Score = probability × impact. 12+ means act now.</li><li>Responses: <b>avoid</b>, <b>reduce</b>, <b>transfer</b>, or <b>accept</b> with a plan B. Every risk has an owner.</li><li>Log important <b>decisions</b> with the why and the alternatives. Future-you will thank you.</li></ul>'],
["report","Status reporting",'<ul><li><b>Green</b>: on track. <b>Amber</b>: at risk, with a plan. <b>Red</b>: off track; we need help or a decision.</li><li>Report Amber early. A project that looks green but is red inside destroys trust.</li><li>Always end with a clear <b>ask</b>, a name, and a date.</li></ul>'],
["retro","Retrospectives",'<ul><li>Blameless: improve the process, not judge people.</li><li>Rotate formats: Start·Stop·Continue (action-focused), 4Ls (after something long or new), Mad·Sad·Glad (when emotions run high).</li><li><b>No action items means no retro.</b> 1–3 actions, each with an owner. Check them at the next retro.</li></ul>'],
["ideas","Brainstorming on the Ideas board",'<p>Use the Ideas board to think <b>before</b> you plan. Ideas are cheap; tasks are commitments.</p><ul><li><b>Diverge, then converge.</b> First everyone drops stickies, with no judging. Then group them into sections, vote, and pick.</li><li><b>One idea per sticky.</b> Short phrases you could read from across a room.</li><li><b>Vote with ♥.</b> Each person gets about 3 votes. The top-voted stickies become candidates.</li><li><b>Make task</b> turns a winning sticky into a Backlog task. Then estimate and prioritize it on the Board.</li><li>Use <b>arrows</b> for cause → effect or "this depends on that".</li></ul><div class="ex">Kickoff recipe (30 min): Brainstorm template → 10 min silent sticky writing → 5 min grouping → 5 min voting → turn the top 5 into tasks → write the charter from the Goals section.</div><p>Shortcuts: <b>V</b> select · <b>S</b> sticky · <b>T</b> text · <b>F</b> section · <b>C</b> connect · <b>Enter</b> edit · <b>Delete</b> remove · <b>Ctrl/⌘+D</b> duplicate.</p>'],
["gloss","Glossary",'<dl class="gl"><dt>Acceptance criteria</dt><dd>The checklist that proves a task is done.</dd><dt>Backlog</dt><dd>Ordered list of work not yet in a sprint.</dd><dt>Blocker</dt><dd>Something stopping work from moving.</dd><dt>Burndown</dt><dd>Work remaining vs. time in a sprint.</dd><dt>Critical path</dt><dd>Longest chain of dependent tasks.</dd><dt>MoSCoW</dt><dd>Must / Should / Could / Won\'t.</dd><dt>RACI</dt><dd>Responsible, Accountable, Consulted, Informed.</dd><dt>RAG</dt><dd>Red / Amber / Green status.</dd><dt>Scope creep</dt><dd>Uncontrolled growth of what must be delivered.</dd><dt>Sprint</dt><dd>A fixed 1–4 week cycle with one goal.</dd><dt>Story points</dt><dd>Relative size: effort + complexity + uncertainty.</dd><dt>Velocity</dt><dd>Points finished per sprint.</dd><dt>WIP limit</dt><dd>Cap on tasks in progress at once.</dd></dl>']];
function renderGuide(){var open=S.sub.guide||"rhythm";
  return'<div class="card hero"><h2>Our playbook</h2><p class="muted">The best practices this tool is built around. Coach links here whenever it flags something.</p></div>'+GUIDE.map(function(g){var on=g[0]===open;return'<div class="card guide" id="g-'+g[0]+'"><div class="row between" style="cursor:pointer" data-a="sub" data-k="guide" data-v="'+(on?"":g[0])+'"><h3 style="margin:0">'+esc(g[1])+'</h3><span class="muted">'+(on?"−":"+")+'</span></div>'+(on?'<div style="margin-top:8px">'+g[2]+'</div>':'')+'</div>'}).join("")}

/* ---------- menus ---------- */
function teamModal(){var p=P();var owner=S.members.some(function(m){return m.id===S.user.id&&m.role==="owner"});
  modal('<div class="mh"><h3>Team · '+esc(p.name)+'</h3><button class="x" data-a="close">×</button></div>'+S.members.map(function(m){return'<div class="row between" style="padding:8px 0;border-bottom:1px solid var(--line)"><span class="row" style="gap:8px">'+avatar(m.id)+'<span><b>'+esc(m.name)+'</b>'+(m.id===S.user.id?" (you)":"")+'<br><span class="small muted">'+esc(m.email)+' · '+m.role+'</span></span></span>'+(owner&&m.role!=="owner"?'<button class="btn ghost small" data-a="removeMember" data-v="'+m.id+'">Remove</button>':(!owner&&m.id===S.user.id?'<button class="btn ghost small" data-a="removeMember" data-v="'+m.id+'">Leave</button>':''))+'</div>'}).join("")+
  (owner?'<h3 style="margin-top:16px">Add a teammate</h3><p class="small muted">They need to create a Tandem account first (same Supabase connection), then add their email here.</p><div class="row"><input class="i" style="flex:1" id="memail" type="email" placeholder="bert@email.com"><button class="btn" data-a="addMember">Add</button></div>'+(DB.kind==="supabase"?'<div class="tip small" style="margin-top:10px">Send them the connection code from <b>Menu → Share connection</b> so their app points to your Supabase.</div>':'<div class="hint">Demo: bert@demo.local is a sample teammate.</div>'):''))}
function morningHTML(){return (hasNative()?(function(){var mc=morningCfg();return'<div class="mnrow"><label class="switch"><input type="checkbox" id="mnOn"'+(mc.on?" checked":"")+'><span></span></label><div class="grow"><b>Daily brief</b><div class="small muted">Due today, overdue, reviews and blockers</div></div><input class="i" type="time" id="mnTime" value="'+pad(mc.h)+':'+pad(mc.m)+'" style="width:118px"></div>'+(mc.on&&!mc.perm?'<div class="tip warnbox small">Notifications are blocked for Tandem. Allow them in Android Settings → Apps → Tandem → Notifications.</div>':'')+'<div class="row" style="margin-top:6px"><button class="btn ghost small" data-a="mnTest">Send a test now</button><button class="btn ghost small" data-a="showBrief">Show today\'s brief</button></div>'})():'<div class="small muted">Install the Tandem Android app to get a notification every morning. Here, a Morning brief card appears on the board the first time you open Tandem each day.</div><button class="btn ghost small" style="margin-top:6px" data-a="showBrief">Show today\'s brief</button>')}
var APP_RELEASE="2.6";
function buildDate(v){var m=/^(\d{4})\.(\d\d)\.(\d\d)-(\d\d)(\d\d)$/.exec(v||"");if(!m)return"";var d=new Date(Date.UTC(+m[1],+m[2]-1,+m[3],+m[4],+m[5]));return d.toLocaleDateString(undefined,{month:"short",day:"numeric",year:"numeric"})+", "+d.toLocaleTimeString(undefined,{hour:"numeric",minute:"2-digit"})}
function notifSettingsHTML(){var m=nMuted(),nat=window.AndroidBridge&&AndroidBridge.notifyToken,st={};try{st=nat&&AndroidBridge.notifyStatus?JSON.parse(AndroidBridge.notifyStatus()):{}}catch(e){}
  var delivery;
  if(nat)delivery=st.perm===false?'<div class="tip warnbox small">Tandem can\'t show notifications. Allow them in Android Settings → Apps → Tandem → Notifications.</div><button class="btn ghost small" data-a="nPerm">Allow notifications</button>':'<div class="tip goodbox small">📲 Phone alerts are on. They arrive even when Tandem is closed (checked about every 15 minutes).</div><button class="btn ghost small" data-a="nTest">Send a test notification</button>';
  else if(hasNative())delivery='<div class="tip infobox small">Update the Tandem app to get phone alerts while the app is closed.</div>';
  else if(window.Notification)delivery=Notification.permission==="granted"?'<div class="tip goodbox small">🔔 Browser alerts are on while Tandem is open in a tab.</div>':Notification.permission==="denied"?'<div class="tip warnbox small">Your browser is blocking notifications for this site. Allow them in the site settings (🔒 in the address bar).</div>':'<button class="btn ghost small" data-a="webNotif">Turn on browser alerts</button>';
  else delivery='';
  return'<p class="small muted" style="margin:0 0 8px">Tell me when…</p><div class="nkinds">'+Object.keys(NKIND).map(function(k){return'<label class="nkrow"><span class="nic">'+NKIND[k][0]+'</span><span class="grow"><b>'+NKIND[k][1]+'</b><span class="small muted">'+NKIND[k][2]+'</span></span><span class="switch"><input type="checkbox" data-a="nkind" data-v="'+k+'"'+(m[k]?'':' checked')+'><span></span></span></label>'}).join("")+'</div>'+
  (NOTIF.mode==="mentions"&&DB.kind!=="demo"?'<div class="tip infobox small">Your database needs the notifications update (supabase/notifications.sql) for assignments, reviews, blockers and phone alerts.</div>':'')+'<div style="margin-top:10px">'+delivery+'</div>'}
function settingsModal(){S.inSettings=true;var nat=appNative();
  var row=function(k,v){return'<div class="setrow"><span class="muted">'+k+'</span><b>'+v+'</b></div>'};
  modal('<div class="mh"><h3>Settings</h3><button class="x" data-a="close">×</button></div>'+
  '<div class="setsec"><div class="slabel">Account</div><div class="row" style="gap:10px">'+avatar(S.user.id)+'<div><b>'+esc(S.user.name||S.user.email)+'</b><div class="small muted">'+esc(S.user.email)+(DB.kind==="demo"?" · demo mode":"")+'</div></div></div></div>'+
  '<div class="setsec"><div class="slabel">Appearance</div><div class="themepick">'+Object.keys(THEMES).map(function(k){return'<button class="tp'+(k===theme?" on":"")+'" data-a="theme" data-v="'+k+'" data-t="'+k+'"><span class="tpl">'+MASCOT[k]+'</span>'+THEMES[k].label+'</button>'}).join("")+'</div>'+
  '<div class="mnrow" style="margin-top:12px"><label class="switch"><input type="checkbox" data-a="tipsToggle"'+(tipsOn()?" checked":"")+'><span></span></label><div class="grow"><b>Term help</b><div class="small muted">Show a ? next to project-management terms</div></div></div></div>'+
  '<div class="setsec"><div class="slabel">Notifications</div>'+notifSettingsHTML()+'<div class="slabel" style="margin:16px 0 8px">Morning brief</div>'+morningHTML()+'</div>'+
  '<div class="setsec"><div class="slabel">About</div><div class="setcard">'+row("Tandem version",APP_RELEASE)+row("Build",esc(APP_VERSION))+(buildDate(APP_VERSION)?row("Released",buildDate(APP_VERSION)):'')+(nat?row("Android app",esc(nat.version)+' <span class="muted small">(build '+nat.code+')</span>'):row("Platform",isDesk()?"Web · desktop":"Web"))+row("Data",DB.kind==="demo"?"Demo (this device)":"Supabase · synced")+'</div>'+
  '<button class="btn ghost" style="width:100%;margin-top:10px" data-a="settingsCheck">'+(nat&&S.apkLatest&&S.apkLatest.code>nat.code?'📲 Update app to '+esc(S.apkLatest.version):'Check for updates')+'</button></div>'+
  '<div class="setsec" style="border:0"><button class="btn ghost" style="width:100%" data-a="signout">Sign out</button></div>',function(){},{drawer:true})}
function settingsCheck(btn){var nat=appNative();if(nat&&S.apkLatest&&S.apkLatest.code>nat.code){installApk();return}
  if(btn){btn.disabled=true;btn.textContent="Checking…"}
  fetch("version.json?t="+Date.now(),{cache:"no-store"}).then(function(r){return r.ok?r.json():null}).then(function(j){
    if(btn){btn.disabled=false;btn.textContent="Check for updates"}
    if(!j){toast("Couldn't check right now");return}checkApk(j);
    if(nat&&j.android&&j.android.code>nat.code){toast("New app version "+j.android.version+" available");settingsModal();return}
    if(j.v&&j.v!==APP_VERSION){toast("Updating to the latest version…");setTimeout(function(){location.reload()},600);return}
    toast("You're on the latest version ✓")}).catch(function(){if(btn){btn.disabled=false;btn.textContent="Check for updates"}toast("Couldn't check right now")})}
function menuModal(){var p=P();var owner=p&&S.members.some(function(m){return m.id===S.user.id&&m.role==="owner"});
  modal('<div class="mh"><h3>'+esc(S.user.name||S.user.email)+'</h3><button class="x" data-a="close">×</button></div><p class="small muted">'+esc(S.user.email)+(DB.kind==="demo"?" · demo mode":"")+'</p>'+
  '<div style="display:grid;gap:8px"><button class="btn" data-a="settings">⚙ Settings · theme, notifications, version</button><button class="btn ghost" data-a="newProject">+ New project</button>'+(p?'<button class="btn ghost" data-a="team">Team & invites</button><button class="btn ghost" data-a="exportProject">Copy project data (JSON backup)</button>':'')+(DB.kind==="supabase"?'<button class="btn ghost" data-a="shareConn">Share connection code</button>':'')+(window.AndroidBridge&&AndroidBridge.setAppUrl?'<button class="btn ghost" data-a="resetAppUrl">Change Tandem website</button>':'')+
  (owner?'<button class="btn ghost" data-a="deleteProject" style="color:var(--bad)">Delete this project</button>':'')+'<button class="btn ghost" data-a="signout">Sign out</button>'+(DB.kind==="demo"?'<button class="btn ghost" data-a="resetDemo">Reset demo data</button>':'')+'<button class="btn ghost" data-a="disconnect">'+(DB.kind==="demo"?"Leave demo":"Disconnect from this Supabase")+'</button></div>')}

/* ================= events ================= */
document.addEventListener("click",async function(e){
  var el=e.target.closest("[data-a]");if(!el)return;var a=el.dataset.a,v=el.dataset.v,p=P();
  if(a==="closeScrim"){if(e.target===el)closeModal();return}
  if(el.tagName==="SELECT"||(el.tagName==="INPUT"&&el.type!=="checkbox"))return;
  if(el.tagName==="A")e.preventDefault();
  if(a==="tip"){e.stopPropagation();e.preventDefault();var o=document.getElementById("tippop");if(o&&o.dataset.k===v){closeTip();return}showTip(el,v);var np=document.getElementById("tippop");if(np)np.dataset.k=v;return}
  if(a==="tipsToggle"){var reS2=!!document.querySelector(".modal .setsec");lsSet("pmhub.tips",tipsOn()?"off":"on");closeModal();S.lastKey=null;render();if(reS2)settingsModal();toast(tipsOn()?"Term help on":"Term help off");return}
  switch(a){
  case"close":closeModal();break;
  case"tab":if(S.tab==="ideas"&&v!=="ideas")wbLeave();S.tab=v;lsSet("pmhub.tab",v);render();window.scrollTo(0,0);break;
  case"goto":closeTip();closeModal();S.tab=v;if(el.dataset.s)S.sub[v]=el.dataset.s;render();window.scrollTo(0,0);if(v==="guide"){var g=document.getElementById("g-"+el.dataset.s);if(g)g.scrollIntoView()}break;
  case"sub":S.sub[el.dataset.k]=v;if(el.dataset.k==="auth")renderAuth();else render();break;
  case"connect":{var code=document.getElementById("ccode").value.trim(),u=document.getElementById("curl").value.trim(),k=document.getElementById("ckey").value.trim();var err=document.getElementById("cerr");
    if(code){try{var o=JSON.parse(atob(code.replace(/^TANDEM:/,"")));u=o.u;k=o.k;if(o.a&&window.AndroidBridge&&AndroidBridge.setAppUrl){AndroidBridge.setAppUrl(o.a);return}}catch(x){err.textContent="That connection code doesn\'t look right.";return}}
    if(!/^https:\/\/.+/.test(u)||k.length<20){err.textContent="Enter the Supabase URL (https://…) and the anon key.";return}
    conn={url:u.replace(/\/+$/,""),key:k};lsSet("pmhub.url",conn.url);lsSet("pmhub.key",conn.key);mode="supabase";lsSet("pmhub.mode",mode);boot();break}
  case"setAppUrl":{var au=document.getElementById("appurl").value.trim().replace(/\/+$/,"");if(au&&!/^https?:\/\//.test(au))au="https://"+au;if(!/^https:\/\/[^\s.]+\.[^\s]+$/.test(au)){document.getElementById("aperr").textContent="Enter your site address, like tandem-xyz.vercel.app";return}AndroidBridge.setAppUrl(au);break}
  case"apkCheck":closeModal();if(S.apkLatest&&S.apkLatest.code>appNative().code)installApk(S.apkLatest);else{fetch("version.json?t="+Date.now(),{cache:"no-store"}).then(function(r){return r.json()}).then(function(j){if(j.android&&j.android.code>appNative().code){lsSet("pmhub.apkLater",null);checkApk(j)}else toast("You have the latest app ("+appNative().version+")")}).catch(function(){toast("Couldn't check for updates")})}break;
  case"resetAppUrl":closeModal();confirmBox("Switch to a different Tandem website? You'll pick it on the next screen.",function(){AndroidBridge.setAppUrl("")},"Switch");break;
  case"demo":mode="demo";lsSet("pmhub.mode","demo");boot();break;
  case"disconnect":closeModal();try{if(DB)await DB.signOut()}catch(x){}mode="";lsSet("pmhub.mode",null);if(!cfg.supabaseUrl){lsSet("pmhub.url",null);lsSet("pmhub.key",null);conn={url:"",key:""}}S.user=null;S.projects=[];S.d=null;renderConnect();break;
  case"signin":{if(DB.kind==="demo"){await DB.signIn();await refreshSession();break}
    var em=document.getElementById("aemail").value.trim(),pw=document.getElementById("apw").value,ae=document.getElementById("aerr");el.disabled=true;ae.textContent="";
    try{if((S.sub.auth||"in")==="up"){var nm=document.getElementById("aname").value.trim();if(!nm)throw new Error("Enter your name");var hasSession=await DB.signUp(em,pw,nm);if(!hasSession){ae.style.color="var(--good)";ae.textContent="Account created. Check your email to confirm, then sign in.";S.sub.auth="in";el.disabled=false;return}}else await DB.signIn(em,pw);await refreshSession()}catch(x){ae.textContent=/fetch|network/i.test(x.message)?"Can't reach Supabase. Check your internet and the Supabase URL.":x.message;el.disabled=false}break}
  case"google":{el.disabled=true;try{await DB.signInGoogle()}catch(x){toast("⚠ "+x.message);el.disabled=false}if(window.AndroidBridge)setTimeout(function(){el.disabled=false},4000);break}
  case"forgot":{var em2=document.getElementById("aemail").value.trim();if(!em2){document.getElementById("aerr").textContent="Enter your email first.";return}try{await DB.resetPw(em2);toast("Password reset email sent")}catch(x){toast(x.message)}break}
  case"signout":closeModal();try{DB.watchNotifs&&DB.watchNotifs(null)}catch(e){}lsSet("pmhub.devReg",null);try{window.AndroidBridge&&AndroidBridge.notifyRegister&&AndroidBridge.notifyRegister("","")}catch(e){}await DB.signOut();S.user=null;S.projects=[];S.d=null;DB.subscribe(null);renderAuth();break;
  case"resetDemo":closeModal();confirmBox("Erase demo data and start over?",function(){DB.reset();location.reload()});break;
  case"menu":menuModal();break;
  case"settings":settingsModal();break;
  case"settingsCheck":settingsCheck(el);break;
  case"nkind":{var mm=nMuted();if(el.checked)delete mm[v];else mm[v]=1;lsSet("pmhub.nmute",JSON.stringify(mm));nBadge();try{if(window.AndroidBridge&&AndroidBridge.notifyConfig)AndroidBridge.notifyConfig(JSON.stringify({mute:mm}))}catch(e){}break}
  case"webNotif":try{Notification.requestPermission().then(function(){settingsModal()})}catch(e){}break;
  case"nPerm":try{AndroidBridge.notifyPerm()}catch(e){}setTimeout(settingsModal,1500);break;
  case"nTest":try{AndroidBridge.notifyTest()}catch(e){}toast("Test sent. Check your notification shade");break;
  case"team":teamModal();break;
  case"addMember":{var me=document.getElementById("memail").value.trim();if(!me)return;try{var r=await DB.addMember(p.id,me);if(r==="not_found")toast("No account with that email yet. Ask them to sign up first.");else{toast("Added to "+p.name);await loadProject(true);teamModal()}}catch(x){toast("⚠ "+x.message)}break}
  case"removeMember":{var self=v===S.user.id;confirmBox(self?"Leave this project? You\'ll lose access.":"Remove "+mname(v)+" from this project?",async function(){try{await DB.removeMember(p.id,v);if(self)await loadProjects();else await loadProject(true)}catch(x){toast("⚠ "+x.message)}},self?"Leave":"Remove");break}
  case"shareConn":{var c="TANDEM:"+btoa(JSON.stringify({u:conn.url,k:conn.key,a:/^https:/.test(location.origin)?location.origin:""}));copyText(c).then(function(ok){modal('<div class="mh"><h3>Connection code</h3><button class="x" data-a="close">×</button></div><p class="small muted">'+(ok?"Copied. ":"")+'Send this to your teammate. They paste it on the Connect screen, then create their own account. It contains your Supabase URL and public anon key, which are safe to share because your data is protected by login and row-level security.</p><textarea class="i" readonly style="min-height:110px;font:12px/1.4 JBMono,monospace">'+esc(c)+'</textarea>')});break}
  case"newProject":closeModal();modal('<div class="mh"><h3>New project</h3><button class="x" data-a="close">×</button></div><label class="f">Project name</label><input class="i" id="npn" placeholder="e.g. FDE interview prep"><div class="hint">Then fill in the charter and invite your teammate.</div><div class="row" style="justify-content:flex-end;margin-top:12px"><button class="btn" id="npok">Create</button></div>',function(m){m.querySelector("#npn").focus();m.querySelector("#npok").onclick=async function(){var n=m.querySelector("#npn").value.trim();if(!n)return;closeModal();try{var np=await DB.createProject(n,S.user.id);S.projects=await DB.projects();S.cur=np.id;lsSet("pmhub.cur",S.cur);S.tab="plan";S.sub.plan="charter";await loadProject();toast("Project created. Start with the charter.")}catch(x){toast("⚠ "+x.message)}}});break;
  case"deleteProject":closeModal();confirmBox("Delete “"+p.name+"” and everything in it for everyone? This can\'t be undone.",async function(){try{await DB.deleteProject(p.id);S.cur=null;await loadProjects()}catch(x){toast("⚠ "+x.message)}},"Delete");break;
  case"exportProject":{closeModal();var blob=JSON.stringify({project:p,members:S.members,data:S.d},null,1);copyText(blob).then(function(ok){toast(ok?"Project data copied as JSON":"Couldn\'t copy on this device")});break}
  case"quickAdd":{var qa=document.getElementById("quickAdd");var tt=qa.value.trim();if(!tt)return;qa.value="";buzz(8);await act(function(){return DB.ins("tasks",{project_id:p.id,title:tt,status:v||"Backlog",assignee:(v&&v!=="Backlog")?S.user.id:null})});var q=document.getElementById("quickAdd");if(q)q.focus();break}
  case"editTask":editTask(v);break;
  case"move":{e.stopPropagation();var t=taskById(v);var i=COLS.indexOf(t.status)+(+el.dataset.d);if(i>=0&&i<COLS.length)setStatus(v,COLS[i]);break}
  case"bfilter":S.filter=v;render();break;
  case"dismissBrief":lsSet("pmhub.brief",today()+"|"+S.cur);S.forceBrief=false;var bc=el.closest(".brief");if(bc&&!reducedMotion()){bc.classList.add("leaving");setTimeout(render,220)}else render();break;
  case"showBrief":closeModal();lsSet("pmhub.brief",null);S.forceBrief=true;S.tab="board";S.lastKey=null;render();window.scrollTo(0,0);break;
  case"mnTest":try{AndroidBridge.morningTest();toast("Test notification sent")}catch(x){toast("Couldn't send")}break;
  case"col":{var ci2=COLS.indexOf(v),cc=COLS.indexOf(S.col||"To Do");if(ci2===cc)break;S.slideDir=ci2>cc?"L":"R";S.col=v;buzz(8);render();break}
  case"theme":theme=v;lsSet("pmhub.theme",v);applyTheme();syncNative();buzz(10);var reS=S.inSettings&&document.querySelector(".modal .setsec");closeModal();S.lastKey=null;if(S.user)render();else if(DB)renderAuth();else renderConnect();if(reS)settingsModal();toast(THEMES[v].label+" theme on");break;
  case"editSprint":editSprint(v);break;
  case"closeSprint":{var sp=D().sprints.filter(function(x){return x.id===v})[0];confirmBox("Close "+sp.name+"? Unfinished tasks go back to the backlog and velocity is recorded.",function(){act(async function(){var st=D().tasks.filter(function(t){return t.sprint_id===sp.id});var vel=st.filter(function(t){return t.status==="Done"}).reduce(function(a,t){return a+(+t.points||0)},0);await DB.upd("sprints",sp.id,{status:"Closed",velocity:vel});var un=st.filter(function(t){return t.status!=="Done"});for(var j=0;j<un.length;j++)await DB.upd("tasks",un[j].id,{sprint_id:null});toast(sp.name+" closed: "+vel+" pts. Time for a retro!");S.sub.sprint="retro"})},"Close sprint");break}
  case"tosprint":{var as=activeSprint();var t2=taskById(v);act(function(){return DB.upd("tasks",v,{sprint_id:as.id,status:t2.status==="Backlog"?"To Do":t2.status})});break}
  case"unsprint":act(function(){return DB.upd("tasks",v,{sprint_id:null})});break;
  case"saveStandup":{var row={yesterday:document.getElementById("su1").value.trim(),today:document.getElementById("su2").value.trim(),blockers:document.getElementById("su3").value.trim()};if(!row.yesterday&&!row.today){toast("Fill in at least done or today");return}
    if(v)act(function(){return DB.upd("standups",v,row)},"Standup updated");else{row.project_id=p.id;row.user_id=S.user.id;row.day=today();act(function(){return DB.ins("standups",row)},row.blockers?"Posted. Your teammate can see the blocker.":"Standup posted")}break}
  case"newRetro":{var f={ssc:["Start · Stop · Continue",["Start","Stop","Continue"]],"4l":["4Ls",["Liked","Learned","Lacked","Longed for"]],msg:["Mad · Sad · Glad",["Mad","Sad","Glad"]]}[v];var lc=D().sprints.filter(function(s){return s.status==="Closed"}).slice(-1)[0];
    act(function(){return DB.ins("retros",{project_id:p.id,sprint_id:lc?lc.id:null,title:f[0]+(lc?" · "+lc.name:""),data:{cols:f[1].map(function(n){return{name:n,notes:[]}}),actions:[]}})});break}
  case"addNote":case"delNote":case"addAct":case"toggleAct":{var rr=D().retros.filter(function(x){return x.id===el.dataset.r})[0];var d=JSON.parse(JSON.stringify(rr.data));
    if(a==="addNote"){var inp=document.getElementById("rn-"+rr.id+"-"+el.dataset.c);if(!inp.value.trim())return;d.cols[+el.dataset.c].notes.push(inp.value.trim())}
    if(a==="delNote")d.cols[+el.dataset.c].notes.splice(+el.dataset.n,1);
    if(a==="addAct"){var at=document.getElementById("ra-"+rr.id).value.trim(),ao=document.getElementById("ro-"+rr.id).value;if(!at)return;if(!ao)toast("Tip: every action needs an owner");d.actions.push({text:at,owner:ao,done:false})}
    if(a==="toggleAct")d.actions[+el.dataset.n].done=el.checked;
    act(function(){return DB.upd("retros",rr.id,{data:d})});break}
  case"saveCharter":{var ch={};document.querySelectorAll("[data-ch]").forEach(function(i){ch[i.dataset.ch]=i.value.trim()});var nm2=document.getElementById("pname").value.trim()||p.name;
    if(await act(function(){return DB.updateProject(p.id,{charter:ch,name:nm2})},"Charter saved")){S.projects=await DB.projects();render()}break}
  case"copyCharter":{var c2=p.charter||{};copyText("PROJECT CHARTER: "+p.name+"\n\nWhy: "+(c2.why||"")+"\nGoal: "+(c2.goal||"")+"\nIn scope: "+(c2.scopeIn||"")+"\nOut of scope: "+(c2.scopeOut||"")+"\nSuccess criteria: "+(c2.success||"")+"\nDeadline: "+(c2.deadline||"")+"\nSponsor: "+(c2.sponsor||"")).then(function(ok){toast(ok?"Charter copied":"Couldn\'t copy")});break}
  case"addPerson":{var n=document.getElementById("pnm").value.trim();if(!n){toast("Enter a name");return}act(function(){return DB.ins("stakeholders",{project_id:p.id,name:n,role:document.getElementById("prl").value.trim(),raci:document.getElementById("prc").value})});break}
  case"delRow":act(function(){return DB.del(el.dataset.t,v)});break;
  case"editRisk":editRisk(v);break;
  case"addDecision":{var dd=document.getElementById("dd").value.trim();if(!dd){toast("What was decided?");return}act(function(){return DB.ins("decisions",{project_id:p.id,decision:dd,why:document.getElementById("dw").value.trim(),alternatives:document.getElementById("da").value.trim(),decided_by:document.getElementById("db").value.trim()})},"Decision logged");break}
  case"saveAsks":{var as2=document.getElementById("asks").value;await act(function(){return DB.updateProject(p.id,{asks:as2})},"Saved");S.projects=await DB.projects();break}
  case"copyReport2":{copyText(reportText()).then(function(ok){toast(ok?"Report copied. Paste it into email or chat.":"Couldn't copy")});break}
  case"pickProj":S.cur=v;lsSet("pmhub.cur",S.cur);S.d=null;S.q="";loadProject();break;
  case"wbOpen":WB.boardId=v;WB.sel=null;WB.dirty=false;S.lastKey=null;render();setTimeout(function(){if(!wbView().fitted){wbFit();wbView().fitted=true}},60);break;
  case"wbNew":newBoardModal();break;
  case"wbMenu":e.stopPropagation();boardMenu(v);break;
  case"snapView":snapView(+v);break;
  case"wbSnapsBack":openSnaps();break;
  case"wbtpl":closeModal();setTimeout(function(){wbTemplate(v)},60);break;
  case"cEdit":{var c0=(S.cmtCache||[]).filter(function(x){return x.id===v})[0];var row=document.querySelector('.comment[data-cid="'+v+'"]');if(!c0||!row)break;var bodyEl=row.querySelector(".cbody");bodyEl.outerHTML='<div class="cedit">'+rtEditorHTML("ced-"+v,rtRender(c0.body))+'<div class="row" style="justify-content:flex-end;gap:6px;margin-top:6px"><button class="btn ghost small" data-a="cEditCancel">Cancel</button><button class="btn small" id="cesave-'+v+'">Save</button></div></div>';
    var ce=row.querySelector(".cedit");var rt2;var saveE=async function(){var html=rt2.get();if(rtIsEmpty(rt2.el))return;try{await DB.updComment(v,html,rtMentions(html).filter(function(u){return u!==S.user.id}));renderComments(openTaskId)}catch(x){toast("⚠ "+x.message)}};rt2=rtWire(ce.querySelector(".rte"),saveE);ce.querySelector("#cesave-"+v).onclick=saveE;rt2.focus();break}
  case"cEditCancel":renderComments(openTaskId);break;
  case"cDel":confirmBox("Delete this comment?",async function(){try{await DB.del("task_comments",v)}catch(x){toast("⚠ "+x.message)}var t0=openTaskId;if(t0){editTask(t0)}else loadProject(true)},"Delete");break;
  case"notifs":openNotifs();break;
  case"openNotif":{closeModal();if(el.dataset.n)markRead(el.dataset.n);openNotifItem(el.dataset.p,v);break}
  case"quickAssign":e.stopPropagation();quickAssign(v);break;
  case"setAssignee":{closeModal();var tt=taskById(el.dataset.t);var nv=v||null;if(tt){tt.assignee=nv;S.justMoved=tt.id;render();S.justMoved=null;act(function(){return DB.upd("tasks",tt.id,{assignee:nv})},nv?"Assigned to "+mname(nv):"Unassigned")}break}
  case"addIn":S.newStatus=v;editTask("");break;
  case"copyReport":{var txt=reportText();document.getElementById("rep").textContent=txt;copyText(txt).then(function(ok){toast(ok?"Report copied. Paste it into email or chat.":"Select the text above to copy it.")});break}
  }
});
document.addEventListener("change",function(e){var el=e.target,p=P();
  if(el.dataset.a==="switchProj"){if(el.value==="__new"){el.value=S.cur||"";var b=document.createElement("button");b.dataset.a="newProject";b.hidden=true;document.body.appendChild(b);b.click();b.remove();return}S.cur=el.value;lsSet("pmhub.cur",S.cur);S.d=null;loadProject()}
  if(el.id==="mnOn"||el.id==="mnTime"){var on=document.getElementById("mnOn").checked,tv=(document.getElementById("mnTime").value||"08:00").split(":");try{AndroidBridge.morningSet(on,+tv[0],+tv[1]);buzz(10);toast(on?"Morning brief set for "+document.getElementById("mnTime").value+" daily":"Morning notification off")}catch(x){}return}
  if(el.dataset.a==="wip"){var n=+el.value;p.wip_limit=n;act(function(){return DB.updateProject(p.id,{wip_limit:n})})}
});
document.addEventListener("input",function(e){if(e.target.id==="search"){S.q=e.target.value;S.focusSearch=true;render();return}if(e.target.id==="asks"){var r=document.getElementById("rep");if(r)r.textContent=reportText()}});
document.addEventListener("keydown",function(e){var tg=e.target,typing=/INPUT|TEXTAREA|SELECT/.test(tg.tagName);
  if(S.tab==="ideas"&&WB.boardId&&!typing&&!document.getElementById("layer").innerHTML){if((e.key==="Delete"||e.key==="Backspace")&&WB.sel){e.preventDefault();wbDel(WB.sel);return}if(e.key==="Escape"){WB.sel=null;WB.linkFrom=null;wbDraw();return}if((e.key==="d"||e.key==="D")&&(e.metaKey||e.ctrlKey)&&WB.sel){e.preventDefault();var it=wbItem(WB.sel);if(it&&it.kind!=="link"){var n=wbAdd({kind:it.kind,x:it.x+24,y:it.y+24,w:it.w,h:it.h,text:it.text,color:it.color});WB.sel=n.id;wbDraw()}return}if(e.key==="Enter"&&WB.sel){e.preventDefault();wbEdit(WB.sel);return}
    var tk={v:"select",s:"sticky",t:"text",f:"frame",c:"link"}[e.key];if(tk&&!e.metaKey&&!e.ctrlKey){var b=document.querySelector('[data-wb=tool][data-v="'+tk+'"]');if(b){b.click();return}}}
  if(!typing&&S.user&&P()&&!document.getElementById("layer").innerHTML&&!e.metaKey&&!e.ctrlKey&&!e.altKey){
    if(e.key==="n"||e.key==="N"){e.preventDefault();editTask("");return}
    if(e.key==="/"){var si=document.getElementById("search");if(!si&&isDesk()){S.tab="board";render();si=document.getElementById("search")}if(si){e.preventDefault();si.focus()}return}
    var n=parseInt(e.key,10);if(n>=1&&n<=TABS.length){S.tab=TABS[n-1][0];lsSet("pmhub.tab",S.tab);render();return}}
  if(e.key==="Escape"&&tg.id==="search"){S.q="";tg.value="";render();return}if(e.key==="Enter"&&e.target.id==="quickAdd"){e.preventDefault();var qb=e.target.parentNode.querySelector('[data-a="quickAdd"]');if(qb)qb.click()}if(e.key==="Escape")closeModal()});
document.addEventListener("visibilitychange",function(){if(document.visibilityState==="visible"&&S.user&&P())loadProject(true)});
try{["(min-width: 700px)","(max-width: 699px)","(min-width: 1100px)"].forEach(function(q){var mq=window.matchMedia(q);var fn=function(){S.lastKey=null;if(S.user)render()};if(mq.addEventListener)mq.addEventListener("change",fn);else mq.addListener(fn)})}catch(e){}
/* auto-update: reload into the newest deploy */
var APP_VERSION="2026.11.04-1339";
function appNative(){try{if(!window.AndroidBridge)return null;if(!AndroidBridge.appInfo)return{version:"1.0",code:1};var i=JSON.parse(AndroidBridge.appInfo());if(!i.code){var p=String(i.version||"2.0").split(".");i.code=p[0]==="2"?6+(+p[1]||0):1}return i}catch(e){return{version:"?",code:1}}}
function checkApk(j){var a=j&&j.android,me=appNative();if(!a||!me||!(a.code>me.code))return;S.apkLatest=a;if(lsGet("pmhub.apkLater")===String(a.code)+"|"+today()||document.getElementById("apkbar"))return;
  var d=document.createElement("div");d.className="updbar apk";d.id="apkbar";d.innerHTML='<span>📲 <b>Tandem '+esc(a.version)+'</b> is available'+(a.notes?'<br><span class="small" style="opacity:.8">'+esc(a.notes)+'</span>':'')+'</span><button class="btn small" id="apkgo">Update</button><button class="x" id="apkx" aria-label="Later" style="color:inherit">×</button>';document.body.appendChild(d);
  d.querySelector("#apkgo").onclick=function(){installApk(a);d.remove()};d.querySelector("#apkx").onclick=function(){lsSet("pmhub.apkLater",String(a.code)+"|"+today());d.remove()}}
function installApk(a){var url=new URL(a.url,location.href).href;try{if(window.AndroidBridge&&AndroidBridge.installUpdate&&AndroidBridge.installUpdate(url)){toast("Downloading the update… Android will ask you to install it.");return}}catch(e){}try{AndroidBridge.openExternal(url);toast("Opening the download in Chrome. Tap the file when it finishes to install.")}catch(e){location.href=url}}
window.TandemUpdateFailed=function(){toast("Couldn't open the installer. Opening the download in Chrome instead.");if(S.apkLatest)try{AndroidBridge.openExternal(new URL(S.apkLatest.url,location.href).href)}catch(e){}};
function checkUpdate(){if(location.protocol==="file:"||!window.fetch)return;fetch("version.json?t="+Date.now(),{cache:"no-store"}).then(function(r){return r.ok?r.json():null}).then(function(j){checkApk(j);if(!j||!j.v||j.v===APP_VERSION)return;
  var busy=document.getElementById("layer").innerHTML||S.wbBusy||(document.activeElement&&/INPUT|TEXTAREA/.test(document.activeElement.tagName));
  if(!busy&&document.visibilityState==="visible"&&S.updateSeen!==j.v){S.updateSeen=j.v;var d=document.createElement("div");d.className="updbar";d.innerHTML='✨ A new version of Tandem is ready. <button class="btn small">Update now</button>';d.querySelector("button").onclick=function(){location.reload()};document.body.appendChild(d)}
  if(document.visibilityState==="hidden")S.reloadOnShow=true}).catch(function(){})}
setInterval(checkUpdate,5*60*1000);setTimeout(checkUpdate,window.AndroidBridge?2500:8000);
document.addEventListener("visibilitychange",function(){if(document.visibilityState==="visible"){if(S.reloadOnShow&&!document.getElementById("layer").innerHTML){location.reload();return}checkUpdate()}});
window.TandemBack=function(){if(document.getElementById("layer").innerHTML){closeModal();return true}return false};

boot();
})();
