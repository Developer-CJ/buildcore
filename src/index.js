var __defProp = Object.defineProperty;
var __name = (target, value) => __defProp(target, "name", { value, configurable: true });

// src/index.js
var json = /* @__PURE__ */ __name((data, status = 200, extra = {}) => new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json; charset=utf-8", ...extra } }), "json");
var now = /* @__PURE__ */ __name(() => (/* @__PURE__ */ new Date()).toISOString(), "now");
var id = /* @__PURE__ */ __name((p) => `${p}_${crypto.randomUUID()}`, "id");
var cors = { "access-control-allow-origin": "*", "access-control-allow-methods": "GET,POST,PATCH,OPTIONS", "access-control-allow-headers": "content-type, authorization, x-cjit-service" };
function withCors(r) {
  const h = new Headers(r.headers);
  for (const [k, v] of Object.entries(cors)) h.set(k, v);
  return new Response(r.body, { status: r.status, headers: h });
}
__name(withCors, "withCors");
var clean = /* @__PURE__ */ __name((p) => p.replace(/\/+/g, "/").replace(/\/$/, "") || "/", "clean");
async function body(r) {
  try {
    return await r.json();
  } catch {
    return {};
  }
}
__name(body, "body");
async function audit(env, b, e, s, a, p) {
  await env.DB.prepare(`INSERT INTO buildcore_audit_events (id,build_id,event_type,message,technician,metadata_json,created_at) VALUES (?,?,?,?,?,?,?)`).bind(id("evt"), b, e, s, a || null, JSON.stringify(p || {}), now()).run();
}
__name(audit, "audit");
async function build(env, b) {
  const x = await env.DB.prepare("SELECT * FROM buildcore_builds WHERE id=?").bind(b).first();
  if (!x) return null;
  const p = await env.DB.prepare("SELECT * FROM buildcore_parts WHERE build_id=? ORDER BY category,name").bind(b).all();
  const s = await env.DB.prepare("SELECT * FROM buildcore_assembly_steps WHERE build_id=? ORDER BY step_number").bind(b).all();
  return { ...x, parts: p.results || [], assembly: s.results || [] };
}
__name(build, "build");
async function progress(env,b){return coreGetProgress(env.DB,b)}
__name(progress,"progress");

const CORE_PHASES = ['LEAD','RECEIVED','PARTS_ORDERED','PARTS_RECEIVED','ASSEMBLY_READY','ASSEMBLY_IN_PROGRESS','ASSEMBLY_COMPLETE','TESTING','QC_PENDING','QC_PASSED','READY_FOR_DELIVERY','DELIVERED','CLOSED'];
const CORE_STATUSES = new Set([...CORE_PHASES,'ON_HOLD','CANCELLED','QC_FAILED','IN_PROGRESS','COMPLETE']);
const coreResponse = (data, status=200) => json(data,status,{'cache-control':'no-store'});
const coreText = (value,max=255) => String(value ?? '').trim().slice(0,max);
const coreAudit = (buildId,event,message,actor,metadata={}) => ({
 id: id('evt'),buildId,event,message,actor:actor||null,metadata:JSON.stringify(metadata),timestamp:now()
});
const coreAuditStmt = (db,e) => db.prepare("INSERT INTO buildcore_audit_events(id,build_id,event_type,message,technician,metadata_json,created_at) VALUES(?,?,?,?,?,?,?)").bind(e.id,e.buildId,e.event,e.message,e.actor,e.metadata,e.timestamp);
async function coreBuildExists(db,b) {return db.prepare("SELECT id,status,progress,customer_name,build_name FROM buildcore_builds WHERE id=?").bind(b).first();}
async function coreGetProgress(db,b) {
 const [row,counts]=await Promise.all([coreBuildExists(db,b),db.prepare("SELECT COUNT(*) total,SUM(CASE WHEN status='COMPLETED' THEN 1 ELSE 0 END) done FROM buildcore_assembly_steps WHERE build_id=?").bind(b).first()]);
 if(!row)return null;
 const computed=Number(counts?.total)>0?Math.round(100*Number(counts?.done||0)/Number(counts.total)):0;
 const pct=Math.max(Number(row.progress)||0,computed);
 const pos=CORE_PHASES.indexOf(row.status);
 const phase=Number(counts.total)>0?(computed===100?'ASSEMBLY_COMPLETE':computed>0?'ASSEMBLY_IN_PROGRESS':'ASSEMBLY_READY'):row.status;
 const proposed=CORE_PHASES.indexOf(phase);
 const newStatus=pos>=0&&pos<proposed?phase:row.status;
 if(pct!==Number(row.progress)||newStatus!==row.status)await db.prepare("UPDATE buildcore_builds SET progress=?,status=?,updated_at=? WHERE id=?").bind(pct,newStatus,now(),b).run();
 return {buildId:b,status:newStatus,progress:pct,assemblyCompleted:Number(counts?.done)||0,assemblyTotal:Number(counts?.total)||0};
}
async function coreExtended(req,env,u,p,m){
 const db=env.DB;
 if(m==='GET'&&(p==='/api/v1/health'||p==='/api/v1/ready')){
   const row=await db.prepare("SELECT (SELECT COUNT(*) FROM buildcore_builds) builds,(SELECT COUNT(*) FROM buildcore_customers) customers,(SELECT COUNT(*) FROM buildcore_assembly_steps) steps").first();
   return coreResponse({ok:true,service:'CJIT BuildCore',database:'connected',version:env.APP_VERSION||'3.0.0',counts:row,timestamp:now()});
 }
 if(m==='GET'&&p==='/api/v1/routes')return coreResponse({ok:true,routes:['GET/POST /api/v1/customers','GET/PATCH /api/v1/customers/:id','GET/POST /api/v1/builds','GET/PATCH /api/v1/builds/:id','GET/PATCH /api/v1/builds/:id/progress','GET/POST /api/v1/builds/:id/plan','GET/POST /api/v1/builds/:id/assembly/steps','POST /api/v1/builds/:id/assembly/steps/:step/complete','GET/POST /api/v1/builds/:id/parts','GET/POST /api/v1/builds/:id/scans','GET/POST /api/v1/builds/:id/qc','GET/POST /api/v1/builds/:id/issues','GET /api/v1/builds/:id/events']});
 if(m==='GET'&&(p==='/api/v1/builds'||p==='/api/v1/builds/refresh')){
   const limit=Math.min(100,Math.max(1,Number.parseInt(u.searchParams.get('limit')||'25',10)||25));
   const offset=Math.min(100000,Math.max(0,Number.parseInt(u.searchParams.get('offset')||'0',10)||0));
   const term=coreText(u.searchParams.get('q')||u.searchParams.get('search')||'',100);
   const status=coreText(u.searchParams.get('status')||'',40);
   const terms=[],params=[];
   if(term){terms.push("(id LIKE ? OR customer_name LIKE ? OR COALESCE(build_name,'') LIKE ? OR COALESCE(technician,'') LIKE ?)");params.push('%'+term+'%','%'+term+'%','%'+term+'%','%'+term+'%');}
   if(status){terms.push('status=?');params.push(status);}
   const clause=terms.length?' WHERE '+terms.join(' AND '):'';
   const [rows,count]=await Promise.all([
    db.prepare('SELECT * FROM buildcore_builds'+clause+' ORDER BY updated_at DESC,id DESC LIMIT ? OFFSET ?').bind(...params,limit,offset).all(),
    db.prepare('SELECT COUNT(*) AS n FROM buildcore_builds'+clause).bind(...params).first()
   ]);
   return coreResponse({ok:true,builds:rows.results||[],total:count?.n||0,limit,offset,query:term});
 }
 if(p==='/api/v1/customers'&&m==='GET'){
   const term=coreText(u.searchParams.get('q')||u.searchParams.get('search')||'',100);
   const limit=Math.min(100,Math.max(1,Number.parseInt(u.searchParams.get('limit')||'100',10)||100));
   const offset=Math.max(0,Number.parseInt(u.searchParams.get('offset')||'0',10)||0);
   const clause=term?" WHERE id LIKE ? OR name LIKE ? OR COALESCE(email,'') LIKE ? OR COALESCE(internal_uid,'') LIKE ?":'';
   const params=term?Array(4).fill('%'+term+'%'):[];
   const [rows,count]=await Promise.all([db.prepare('SELECT * FROM buildcore_customers'+clause+' ORDER BY updated_at DESC LIMIT ? OFFSET ?').bind(...params,limit,offset).all(),db.prepare('SELECT COUNT(*) AS n FROM buildcore_customers'+clause).bind(...params).first()]);
   return coreResponse({ok:true,customers:rows.results||[],total:count?.n||0,limit,offset});
 }
 let mat=p.match(/^\/api\/v1\/customers\/([^/]+)$/);
 if(mat&&['GET','PATCH','PUT'].includes(m)){
   const cid=decodeURIComponent(mat[1]),old=await db.prepare('SELECT * FROM buildcore_customers WHERE id=?').bind(cid).first();
   if(!old)return coreResponse({ok:false,error:'Customer not found'},404);
   if(m==='GET')return coreResponse({ok:true,customer:old});
   const d=await body(req);
   const permitted=['name','email','phone','notes'],changes=permitted.filter(k=>Object.prototype.hasOwnProperty.call(d,k));
   if(!changes.length)return coreResponse({ok:false,error:'No customer fields supplied'},400);
   if('name' in d&&!coreText(d.name,181))return coreResponse({ok:false,error:'Customer name required'},400);
   await db.prepare('UPDATE buildcore_customers SET '+changes.map(k=>k+'=?').join(',')+',updated_at=? WHERE id=?').bind(...changes.map(k=>d[k]===null?null:coreText(d[k],k==='notes'?4096:180)),now(),cid).run();
   return coreResponse({ok:true,customer:await db.prepare('SELECT * FROM buildcore_customers WHERE id=?').bind(cid).first()});
 }
 if(m==='POST'&&p==='/api/v1/builds'){
   const d=await body(req),customerName=coreText(d.customerName||d.customer_name,180),name=coreText(d.buildName||d.build_name,180);
   if(!customerName)return coreResponse({ok:false,error:'customerName is required'},400);
   const bid=coreText(d.buildId||d.id||'CJIT-PC-'+new Date().getUTCFullYear().toString().slice(-2)+'-'+crypto.randomUUID().slice(0,8).toUpperCase(),100);
   if(!/^[A-Za-z0-9_-]{3,100}$/.test(bid))return coreResponse({ok:false,error:'Invalid buildId'},400);
   if(await coreBuildExists(db,bid))return coreResponse({ok:false,error:'Build ID already exists',buildId:bid},409);
   const cid=coreText(d.customerId||d.customer_id,100)||null,t=now();
   if(cid&&!await db.prepare('SELECT id FROM buildcore_customers WHERE id=?').bind(cid).first())return coreResponse({ok:false,error:'Customer ID does not exist'},400);
   const ev=coreAudit(bid,'BUILD_CREATED','Build created',coreText(d.technician,100),{source:'BuildOS',customerName,buildName:name});
   await db.batch([
     db.prepare("INSERT INTO buildcore_builds(id,customer_id,customer_name,build_name,status,source,progress,technician,created_at,updated_at) VALUES(?,?,?,?,'RECEIVED',?,0,?,?,?)").bind(bid,cid,customerName,name||null,coreText(d.source||'BuildOS',60),coreText(d.technician,100)||null,t,t),
     coreAuditStmt(db,ev)
   ]);
   return coreResponse({ok:true,build:await build(env,bid)},201);
 }
 mat=p.match(/^\/api\/v1\/builds\/([^/]+)$/);
 if(mat&&['PATCH','PUT'].includes(m)){
   const bid=decodeURIComponent(mat[1]),old=await coreBuildExists(db,bid);
   if(!old)return coreResponse({ok:false,error:'Build not found'},404);
   const d=await body(req),fields={customerName:'customer_name',buildName:'build_name',technician:'technician',status:'status',progress:'progress',customerId:'customer_id',source:'source'};
   const requested=Object.keys(fields).filter(k=>Object.prototype.hasOwnProperty.call(d,k));
   if(!requested.length)return coreResponse({ok:false,error:'No supported fields supplied'},400);
   if('customerName'in d&&!coreText(d.customerName))return coreResponse({ok:false,error:'customerName cannot be empty'},400);
   if('status'in d){
      const target=coreText(d.status,50).toUpperCase();
      if(!CORE_STATUSES.has(target))return coreResponse({ok:false,error:'Invalid build status'},400);
      const oldIndex=CORE_PHASES.indexOf(old.status),newIndex=CORE_PHASES.indexOf(target);
      if(oldIndex>=0&&newIndex>=0&&newIndex<oldIndex&&!d.allowReopen)return coreResponse({ok:false,error:'Cannot regress lifecycle without allowReopen and reason'},409);
      if(oldIndex>=0&&newIndex>=0&&newIndex<oldIndex&&!coreText(d.reason))return coreResponse({ok:false,error:'Reason required for lifecycle rollback'},400);
      d.status=target;
   }
   if('progress'in d){const n=Number(d.progress);if(!Number.isInteger(n)||n<0||n>100)return coreResponse({ok:false,error:'Progress must be 0-100'},400);if(n<Number(old.progress||0)&&!d.allowReopen)return coreResponse({ok:false,error:'Cannot decrease progress without explicit override'},409);}
   if('customerId'in d&&d.customerId&&!await db.prepare('SELECT id FROM buildcore_customers WHERE id=?').bind(String(d.customerId)).first())return coreResponse({ok:false,error:'Customer does not exist'},400);
   const cols=requested.map(k=>fields[k]);
   const values=requested.map(k=>k==='progress'?Number(d[k]):(d[k]===null?null:coreText(d[k],k==='customerName'||k==='buildName'?180:100)));
   if('status'in d&&CORE_PHASES.indexOf(d.status)>=CORE_PHASES.indexOf('ASSEMBLY_COMPLETE')&&!cols.includes('progress')){cols.push('progress');values.push(Math.max(Number(old.progress)||0,100));}
   const ev=coreAudit(bid,'BUILD_UPDATED','Build updated',coreText(d.technician,100),{fields:requested,reason:coreText(d.reason,500)||null});
   await db.batch([
     db.prepare('UPDATE buildcore_builds SET '+cols.map(c=>c+'=?').join(',')+',updated_at=? WHERE id=?').bind(...values,now(),bid),
     coreAuditStmt(db,ev)
   ]);
   return coreResponse({ok:true,build:await build(env,bid)});
 }
 mat=p.match(/^\/api\/v1\/builds\/([^/]+)\/(progress|phase|transition)$/);
 if(mat){
   const bid=decodeURIComponent(mat[1]);
   if(!await coreBuildExists(db,bid))return coreResponse({ok:false,error:'Build not found'},404);
   if(m==='GET')return coreResponse({ok:true,...await coreGetProgress(db,bid)});
   if(['PATCH','POST'].includes(m)){
     const d=await body(req),target=coreText(d.status||d.phase||'',50).toUpperCase();
     if(!CORE_STATUSES.has(target))return coreResponse({ok:false,error:'Valid lifecycle status required'},400);
     const old=await coreBuildExists(db,bid),from=CORE_PHASES.indexOf(old.status),to=CORE_PHASES.indexOf(target);
     if(from>=0&&to>=0&&to<from&&!(d.allowReopen&&coreText(d.reason)))return coreResponse({ok:false,error:'Lifecycle regression blocked; allowReopen and reason required'},409);
     const ev=coreAudit(bid,'BUILD_PHASE_CHANGED','Phase: '+old.status+' -> '+target,coreText(d.technician,100),{from:old.status,to:target,reason:coreText(d.reason,400)});
     await db.batch([db.prepare('UPDATE buildcore_builds SET status=?,progress=?,updated_at=? WHERE id=?').bind(target,Math.max(Number(old.progress)||0,CORE_PHASES.indexOf(target)>=CORE_PHASES.indexOf('ASSEMBLY_COMPLETE')?100:0),now(),bid),coreAuditStmt(db,ev)]);
     return coreResponse({ok:true,...await coreGetProgress(db,bid)});
   }
 }
 mat=p.match(/^\/api\/v1\/builds\/([^/]+)\/(?:plan|generate-plan)$/);
 if(mat&&['GET','POST'].includes(m)){
   const bid=decodeURIComponent(mat[1]),old=await coreBuildExists(db,bid);
   if(!old)return coreResponse({ok:false,error:'Build not found'},404);
   const existing=await db.prepare('SELECT * FROM buildcore_assembly_steps WHERE build_id=? ORDER BY step_number').bind(bid).all();
   if(m==='GET'||(existing.results||[]).length)return coreResponse({ok:true,steps:existing.results||[],generated:false,alreadyExists:(existing.results||[]).length>0});
   const steps=[
    ['Intake & specifications','Review customer requirements, inventory, component compatibility, and acceptance criteria.','Record customer-approved scope.'],
    ['Inventory verification','Confirm CPU, motherboard, memory, storage, power supply, cooling and peripherals; verify part identifiers.','Record missing or mismatched parts.'],
    ['Bench and ESD preparation','Prepare grounded ESD-safe workspace, tools, thermal paste, cable labels and checklist.','Confirm safe handling.'],
    ['Motherboard assembly','Install CPU, cooling hardware, RAM and compatible storage; inspect sockets and headers.','Photograph assembly and inspect seating.'],
    ['Chassis and power installation','Mount motherboard, supply, fans, panels and airflow; connect power cables and case headers.','Verify clearances and cable routing.'],
    ['First POST & firmware','Power on, inspect BIOS/UEFI, update firmware as approved, confirm detection and safe temperatures.','Capture POST and hardware detection results.'],
    ['OS and driver provisioning','Install OS, required updates, chipset and device drivers; configure baseline security.','Document installation success.'],
    ['Functional diagnostics','Test network, storage, memory, graphics, audio, peripherals and expected workloads.','Record diagnostic evidence.'],
    ['Thermal and stability validation','Perform appropriate bounded load/stability tests, confirm safe thermals and absence of errors.','Record temperatures and test duration.'],
    ['Final QC and delivery preparation','Review build photos, resolve open issues, verify cleanliness, documentation, and customer handoff.','Obtain final QC sign-off.']
   ];
   const t=now(),items=steps.map(([title,instructions,verification],i)=>({id:id('step'),build_id:bid,step_number:i+1,title,instructions,verification}));
   const ev=coreAudit(bid,'BUILD_PLAN_GENERATED','Standard 10-step build plan generated',null,{steps:items.length});
   await db.batch([...items.map(s=>db.prepare("INSERT INTO buildcore_assembly_steps(id,build_id,step_number,title,instructions,verification,status) VALUES(?,?,?,?,?,?,'PENDING')").bind(s.id,s.build_id,s.step_number,s.title,s.instructions,s.verification)),coreAuditStmt(db,ev),db.prepare("UPDATE buildcore_builds SET status=CASE WHEN status IN ('LEAD','RECEIVED') THEN 'ASSEMBLY_READY' ELSE status END,updated_at=? WHERE id=?").bind(t,bid)]);
   const added=await db.prepare('SELECT * FROM buildcore_assembly_steps WHERE build_id=? ORDER BY step_number').bind(bid).all();
   return coreResponse({ok:true,steps:added.results||[],generated:true},201);
 }
 mat=p.match(/^\/api\/v1\/builds\/([^/]+)\/assembly\/steps$/);
 if(mat&&['POST','GET'].includes(m)){
   const bid=decodeURIComponent(mat[1]);
   if(!await coreBuildExists(db,bid))return coreResponse({ok:false,error:'Build not found'},404);
   if(m==='GET'){const x=await db.prepare('SELECT * FROM buildcore_assembly_steps WHERE build_id=? ORDER BY step_number').bind(bid).all();return coreResponse({ok:true,steps:x.results||[]});}
   const d=await body(req),title=coreText(d.title,180),instructions=coreText(d.instructions,4000);
   if(!title||!instructions)return coreResponse({ok:false,error:'title and instructions are required'},400);
   const r=await db.prepare('SELECT COALESCE(MAX(step_number),0)+1 next FROM buildcore_assembly_steps WHERE build_id=?').bind(bid).first();
   const sid=id('step'),number=Number(r?.next||1),ev=coreAudit(bid,'ASSEMBLY_STEP_ADDED',title,coreText(d.technician,100),{stepId:sid,number});
   await db.batch([db.prepare("INSERT INTO buildcore_assembly_steps(id,build_id,step_number,title,instructions,warning,verification,status) VALUES(?,?,?,?,?,?,?,'PENDING')").bind(sid,bid,number,title,instructions,coreText(d.warning,500)||null,coreText(d.verification,500)||null),coreAuditStmt(db,ev)]);
   return coreResponse({ok:true,step:await db.prepare('SELECT * FROM buildcore_assembly_steps WHERE id=?').bind(sid).first()},201);
 }
 mat=p.match(/^\/api\/v1\/builds\/([^/]+)\/assembly\/steps\/([^/]+)(?:\/(complete|reset))?$/);
 if(mat&&(m==='PATCH'||m==='POST')){
   const bid=decodeURIComponent(mat[1]),sid=decodeURIComponent(mat[2]),d=await body(req);
   const old=await db.prepare('SELECT id,status FROM buildcore_assembly_steps WHERE build_id=? AND id=?').bind(bid,sid).first();
   if(!old)return coreResponse({ok:false,error:'Assembly step not found'},404);
   const target=mat[3]==='reset'?'PENDING':mat[3]==='complete'?'COMPLETED':coreText(d.status,32).toUpperCase();
   if(!['PENDING','IN_PROGRESS','COMPLETED','BLOCKED','SKIPPED'].includes(target))return coreResponse({ok:false,error:'Unsupported assembly step status'},400);
   if(old.status!==target){
     const tech=coreText(d.technician,100),ev=coreAudit(bid,'ASSEMBLY_STEP_'+target,'Assembly step '+target,tech,{stepId:sid,previous:old.status});
     await db.batch([db.prepare("UPDATE buildcore_assembly_steps SET status=?,completed_at=?,completed_by=?,notes=COALESCE(?,notes) WHERE id=? AND build_id=?").bind(target,target==='COMPLETED'?now():null,target==='COMPLETED'?(tech||null):null,coreText(d.notes,1000)||null,sid,bid),coreAuditStmt(db,ev)]);
   }
   return coreResponse({ok:true,stepId:sid,stepStatus:target,...await coreGetProgress(db,bid)});
 }
 mat=p.match(/^\/api\/v1\/builds\/([^/]+)\/issues(?:\/([^/]+))?$/);
 if(mat&&['GET','POST','PATCH'].includes(m)){
   const bid=decodeURIComponent(mat[1]);
   if(!await coreBuildExists(db,bid))return coreResponse({ok:false,error:'Build not found'},404);
   if(m==='GET'){const x=await db.prepare('SELECT * FROM buildcore_build_issues WHERE build_id=? ORDER BY created_at DESC').bind(bid).all();return coreResponse({ok:true,issues:x.results||[]});}
   const d=await body(req);
   if(m==='POST'&&!mat[2]){
     const title=coreText(d.title,180);if(!title)return coreResponse({ok:false,error:'Issue title required'},400);
     const iid=id('issue'),ev=coreAudit(bid,'ISSUE_OPENED',title,coreText(d.technician,100),{issueId:iid});
     await db.batch([db.prepare("INSERT INTO buildcore_build_issues(id,build_id,severity,title,notes,status,created_by,created_at) VALUES(?,?,?,?,?,'OPEN',?,?)").bind(iid,bid,coreText(d.severity||'MEDIUM',30).toUpperCase(),title,coreText(d.notes,2000)||null,coreText(d.technician,100)||null,now()),coreAuditStmt(db,ev)]);
     return coreResponse({ok:true,issue:await db.prepare('SELECT * FROM buildcore_build_issues WHERE id=?').bind(iid).first()},201);
   }
   if(m==='PATCH'&&mat[2]){
     const iid=decodeURIComponent(mat[2]),issue=await db.prepare('SELECT id,status FROM buildcore_build_issues WHERE id=? AND build_id=?').bind(iid,bid).first();
     if(!issue)return coreResponse({ok:false,error:'Issue not found'},404);
     const status=coreText(d.status,24).toUpperCase();if(!['OPEN','IN_PROGRESS','RESOLVED','CLOSED'].includes(status))return coreResponse({ok:false,error:'Invalid issue status'},400);
     const ev=coreAudit(bid,'ISSUE_UPDATED','Issue '+status,coreText(d.technician,100),{issueId:iid});
     await db.batch([db.prepare('UPDATE buildcore_build_issues SET status=?,resolved_by=?,resolved_at=?,notes=COALESCE(?,notes) WHERE id=? AND build_id=?').bind(status,['CLOSED','RESOLVED'].includes(status)?coreText(d.technician,100)||null:null,['CLOSED','RESOLVED'].includes(status)?now():null,coreText(d.notes,2000)||null,iid,bid),coreAuditStmt(db,ev)]);
     return coreResponse({ok:true,issue:await db.prepare('SELECT * FROM buildcore_build_issues WHERE id=?').bind(iid).first()});
   }
 }
 mat=p.match(/^\/api\/v1\/builds\/([^/]+)\/parts$/);
 if(mat&&m==='POST'){
   const bid=decodeURIComponent(mat[1]),d=await body(req);
   if(!await coreBuildExists(db,bid))return coreResponse({ok:false,error:'Build not found'},404);
   const name=coreText(d.name,180),category=coreText(d.category,100);
   if(!name||!category)return coreResponse({ok:false,error:'name and category required'},400);
   const pid=coreText(d.partId||id('part'),100),t=now(),qty=Math.max(1,Math.min(1000,Number.parseInt(d.quantity??d.expected??1,10)||1));
   const ev=coreAudit(bid,'PART_CREATED','Part added: '+name,coreText(d.technician,100),{partId:pid});
   await db.batch([db.prepare("INSERT INTO buildcore_parts(id,build_id,sku,barcode,name,category,manufacturer,model,quantity,status,sort_order,metadata_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)").bind(pid,bid,coreText(d.sku,100)||null,coreText(d.barcode,100)||null,name,category,coreText(d.manufacturer,100)||null,coreText(d.model,100)||null,qty,coreText(d.status||'ORDERED',30),Number(d.sortOrder)||0,JSON.stringify({serialNumber:coreText(d.serialNumber,100)||null,source:coreText(d.source||'BuildOS',30)}),t,t),coreAuditStmt(db,ev)]);
   return coreResponse({ok:true,part:await db.prepare('SELECT * FROM buildcore_parts WHERE id=?').bind(pid).first()},201);
 }
 mat=p.match(/^\/api\/v1\/builds\/([^/]+)\/scans$/);
 if(mat&&m==='POST'){
   const bid=decodeURIComponent(mat[1]),d=await body(req),code=coreText(d.code||d.scanned_value,200);
   if(!code)return coreResponse({ok:false,error:'Scan code required'},400);
   if(!await coreBuildExists(db,bid))return coreResponse({ok:false,error:'Build not found'},404);
   const part=await db.prepare('SELECT * FROM buildcore_parts WHERE build_id=? AND (barcode=? OR sku=? OR id=? OR model=?) LIMIT 1').bind(bid,code,code,code,code).first(),sid=id('scan'),tech=coreText(d.technician,100);
   const ev=coreAudit(bid,part?'PART_SCANNED':'UNKNOWN_PART_SCANNED','Barcode scan',tech,{scanId:sid,matched:!!part,partId:part?.id||null});
   const stmts=[db.prepare('INSERT INTO buildcore_scan_events(id,build_id,part_id,scanned_value,result,technician,created_at) VALUES(?,?,?,?,?,?,?)').bind(sid,bid,part?.id||null,code,part?'MATCHED':'UNMATCHED',tech||null,now())];
   if(part)stmts.push(db.prepare("UPDATE buildcore_parts SET status='SCANNED',updated_at=? WHERE id=?").bind(now(),part.id));
   stmts.push(coreAuditStmt(db,ev));await db.batch(stmts);
   return coreResponse({ok:true,matched:!!part,part:part||null,scanId:sid});
 }
 mat=p.match(/^\/api\/v1\/builds\/([^/]+)\/qc$/);
 if(mat&&m==='POST'){
   const bid=decodeURIComponent(mat[1]),d=await body(req),category=coreText(d.category||d.check_name,180),result=coreText(d.status||d.result,100);
   if(!category||!result)return coreResponse({ok:false,error:'QC category and result are required'},400);
   if(!await coreBuildExists(db,bid))return coreResponse({ok:false,error:'Build not found'},404);
   const qid=id('qc'),tech=coreText(d.technician,100),ev=coreAudit(bid,'QC_RECORDED','QC: '+category,tech,{qcId:qid,result});
   await db.batch([db.prepare('INSERT INTO buildcore_qc_events(id,build_id,check_name,result,notes,technician,created_at) VALUES(?,?,?,?,?,?,?)').bind(qid,bid,category,result,coreText(d.notes,2000)||null,tech||null,now()),coreAuditStmt(db,ev)]);
   return coreResponse({ok:true,qcId:qid},201);
 }
 return null;
}

async function handle(req, env) {
  const u = new URL(req.url), p = clean(u.pathname), m = req.method.toUpperCase();
  if (m === "OPTIONS") return new Response(null, { status: 204, headers: cors });
  if (m === "GET" && p === "/") return json({ ok: true, system: "CJIT Systems Universal API", service: env.APP_NAME || "CJIT BuildCore", version: env.APP_VERSION || "1.0.0", environment: env.ENVIRONMENT || "unknown", status: "ONLINE", health: "/api/gateway/health", buildcoreHealth: "/health", buildcoreApi: "/api/v1", universalApi: "/api/routes", timestamp: now() });
  if (p === "/health") return json({ ok: true, service: env.APP_NAME || "CJIT BuildCore", version: env.APP_VERSION || "1.0.0", environment: env.ENVIRONMENT || "unknown", timestamp: now() });
  if (m === "GET" && p === "/api/gateway/routes") return json({ ok: true, system: "CJIT Systems Universal API", routes: [{ method: "GET", path: "/", target: "Gateway status" }, { method: "GET", path: "/api/gateway/health", target: "Aggregate health" }, { method: "GET", path: "/health", target: "BuildCore health" }, { method: "*", path: "/api/v1/*", target: "BuildCore" }, { method: "*", path: "/api/*", target: "CJIT API Manager" }] });
  if (m === "GET" && p === "/api/gateway/health") {
    try {
      const manager = await fetch("https://api.cjitsystems.com/api/health", { headers: { accept: "application/json" } });
      const ok = manager.ok && !!env.DB;
      return json({ ok, system: "CJIT Systems Universal API", services: { universal: { status: manager.ok ? "online" : "down", httpStatus: manager.status }, buildcore: { status: env.DB ? "online" : "down", databaseBound: !!env.DB } }, timestamp: now() }, ok ? 200 : 503);
    } catch {
      return json({ ok: false, system: "CJIT Systems Universal API", services: { universal: { status: "down" }, buildcore: { status: env.DB ? "online" : "down" } }, timestamp: now() }, 503);
    }
  }
  if (p === "/api/health" || (p.startsWith("/api/") && !p.startsWith("/api/v1/"))) {
    const upstream = new URL(req.url);
    upstream.hostname = "api.cjitsystems.com";
    return fetch(new Request(upstream, req));
  }
  if(p.startsWith("/api/v1/")){
    const secret=typeof env.API_TOKEN==="string"?env.API_TOKEN:"";
    const bearer=req.headers.get("authorization")||"";
    const expected="Bearer "+secret;
    if(!secret||bearer.length!==expected.length||![...expected].every((v,i)=>v===bearer[i]))return json({ok:false,error:"API authentication required"},401,{"cache-control":"no-store"});
  }
  if (!env.DB) return json({ ok: false, error: "D1 binding DB is not configured." }, 500);
  const extended = await coreExtended(req,env,u,p,m); if(extended) return extended;
  if(m==="GET"&&p==="/api/v1/builds"){
    const limit=Math.max(1,Math.min(100,Math.trunc(Number(u.searchParams.get("limit"))||25)));
    const offset=Math.max(0,Math.min(100000,Math.trunc(Number(u.searchParams.get("offset"))||0)));
    const [result,total]=await Promise.all([env.DB.prepare("SELECT * FROM buildcore_builds ORDER BY updated_at DESC LIMIT ? OFFSET ?").bind(limit,offset).all(),env.DB.prepare("SELECT COUNT(*) AS n FROM buildcore_builds").first()]);
    return json({ok:true,builds:result.results||[],total:total?.n||0,limit,offset});
  }
  if(m==="GET"&&p==="/api/v1/customers"){
    const result=await env.DB.prepare("SELECT id,internal_uid,name,email,phone,notes,created_at,updated_at FROM buildcore_customers ORDER BY updated_at DESC LIMIT 100").all();
    return json({ok:true,customers:result.results||[]});
  }
  if(m==="POST"&&p==="/api/v1/customers"){
    const d=await body(req),name=String(d.name||"").trim();
    if(!name||name.length>180)return json({ok:false,error:"Valid customer name required"},400);
    const idValue=String(d.id||id("cust")),uid=String(d.internalUid||id("cuid")),t=now();
    await env.DB.prepare("INSERT INTO buildcore_customers(id,internal_uid,name,email,phone,notes,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)").bind(idValue,uid,name,d.email||null,d.phone||null,d.notes||null,t,t).run();
    return json({ok:true,customer:{id:idValue,internal_uid:uid,name}},201);
  }
  let q = p.match(/^\/api\/v1\/builds\/([^/]+)$/);
  if (m === "GET" && q) {
    const b = await build(env, decodeURIComponent(q[1]));
    return b ? json({ ok: true, build: b }) : json({ ok: false, error: "Build not found." }, 404);
  }
  if (m === "POST" && p === "/api/v1/builds") {
    const d = await body(req);
    if (!d.buildId || !d.customerName) return json({ ok: false, error: "buildId and customerName are required." }, 400);
    const t = now();
    await env.DB.prepare("INSERT INTO buildcore_builds (id,customer_id,customer_name,build_name,status,source,progress,technician,created_at,updated_at) VALUES (?,?,?,?,'RECEIVED',?,0,?,?,?)").bind(d.buildId, d.customerId || null, d.customerName, d.buildName || null, d.source || "BuildOS", d.technician || null, t, t).run();
    await audit(env, d.buildId, "BUILD_CREATED", d.source || "BuildOS", d.technician, d);
    return json({ ok: true, build: await build(env, d.buildId) }, 201);
  }
  q = p.match(/^\/api\/v1\/builds\/([^/]+)\/parts$/);
  if (q) {
    const b = decodeURIComponent(q[1]);
    if (!await env.DB.prepare("SELECT id FROM buildcore_builds WHERE id=?").bind(b).first()) return json({ ok: false, error: "Build not found." }, 404);
    if (m === "GET") {
      const x = await env.DB.prepare("SELECT * FROM buildcore_parts WHERE build_id=? ORDER BY category,name").bind(b).all();
      return json({ ok: true, parts: x.results || [] });
    }
    if (m === "POST") {
      const d = await body(req);
      if (!d.name || !d.category) return json({ ok: false, error: "name and category are required." }, 400);
      const pid = d.partId || id("part"), t = now();
      await env.DB.prepare("INSERT INTO buildcore_parts (id,build_id,sku,barcode,name,category,manufacturer,model,quantity,status,sort_order,metadata_json,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)").bind(pid, b, d.sku || null, d.barcode || null, d.name, d.category, d.manufacturer || null, d.model || null, Math.max(1,Number(d.quantity ?? d.expected ?? 1)), d.status || "ORDERED", Number(d.sortOrder || 0), JSON.stringify({serialNumber:d.serialNumber || null,source:d.source || "BuildOS"}), t, t).run();
      await audit(env, b, "PART_CREATED", d.source || "BuildOS", d.technician, { partId: pid, ...d });
      return json({ ok: true, part: await env.DB.prepare("SELECT * FROM buildcore_parts WHERE id=?").bind(pid).first() }, 201);
    }
  }
  q = p.match(/^\/api\/v1\/builds\/([^/]+)\/scans$/);
  if (m === "POST" && q) {
    const b = decodeURIComponent(q[1]), d = await body(req);
    if (!d.code) return json({ ok: false, error: "code is required." }, 400);
    const part = await env.DB.prepare("SELECT * FROM buildcore_parts WHERE build_id=? AND (barcode=? OR sku=? OR id=? OR model=?) LIMIT 1").bind(b, d.code, d.code, d.code, d.code).first(), sid = id("scan");
    await env.DB.prepare("INSERT INTO buildcore_scan_events (id,build_id,part_id,scanned_value,result,technician,created_at) VALUES (?,?,?,?,?,?,?)").bind(sid, b, part?.id || null, d.code, part ? "MATCHED" : "UNMATCHED", d.technician || null, now()).run();
    if (part) await env.DB.prepare("UPDATE buildcore_parts SET status='SCANNED',updated_at=? WHERE id=?").bind(now(), part.id).run();
    await audit(env, b, part ? "PART_SCANNED" : "UNKNOWN_PART_SCANNED", d.source || "BuildAssist", d.technician, { code: d.code, partId: part?.id || null });
    return json({ ok: true, matched: !!part, part: part || null, scanId: sid });
  }
  q = p.match(/^\/api\/v1\/builds\/([^/]+)\/assembly\/steps\/([^/]+)\/complete$/);
  if (m === "POST" && q) {
    const b = decodeURIComponent(q[1]), sid = decodeURIComponent(q[2]), d = await body(req), s = await env.DB.prepare("SELECT * FROM buildcore_assembly_steps WHERE id=? AND build_id=?").bind(sid, b).first();
    if (!s) return json({ ok: false, error: "Assembly step not found." }, 404);
    await env.DB.prepare("UPDATE buildcore_assembly_steps SET status='COMPLETED',completed_by=?,completed_at=? WHERE id=? AND build_id=?").bind(d.technician || null, now(), sid, b).run();
    const r = await progress(env, b);
    await audit(env, b, "ASSEMBLY_STEP_COMPLETED", d.source || "BuildAssist", d.technician, { stepId: sid });
    return json({ ok: true, stepId: sid, ...r });
  }
  q = p.match(/^\/api\/v1\/builds\/([^/]+)\/assembly$/);
  if (m === "GET" && q) {
    const x = await env.DB.prepare("SELECT * FROM buildcore_assembly_steps WHERE build_id=? ORDER BY step_number").bind(decodeURIComponent(q[1])).all();
    return json({ ok: true, steps: x.results || [] });
  }
  q = p.match(/^\/api\/v1\/builds\/([^/]+)\/qc$/);
  if (q) {
    const b = decodeURIComponent(q[1]);
    if (m === "GET") {
      const x = await env.DB.prepare("SELECT * FROM buildcore_qc_events WHERE build_id=? ORDER BY created_at DESC").bind(b).all();
      return json({ ok: true, qc: x.results || [] });
    }
    if (m === "POST") {
      const d = await body(req);
      if (!d.category || !d.status) return json({ ok: false, error: "category and status are required." }, 400);
      const qid = id("qc");
      await env.DB.prepare("INSERT INTO buildcore_qc_events (id,build_id,check_name,result,notes,technician,created_at) VALUES (?,?,?,?,?,?,?)").bind(qid, b, d.category, d.status, d.notes || null, d.technician || null, now()).run();
      await audit(env, b, "QC_RECORDED", d.source || "BuildAssist", d.technician, { qcId: qid, ...d });
      return json({ ok: true, qcId: qid }, 201);
    }
  }
  q = p.match(/^\/api\/v1\/builds\/([^/]+)\/events$/);
  if (m === "GET" && q) {
    const x = await env.DB.prepare("SELECT * FROM buildcore_audit_events WHERE build_id=? ORDER BY created_at DESC LIMIT 250").bind(decodeURIComponent(q[1])).all();
    return json({ ok: true, events: x.results || [] });
  }
  return json({ ok: false, error: "Route not found." }, 404);
}
__name(handle, "handle");
var index_default = { async fetch(req, env, ctx) {
  try {
    return withCors(await handle(req, env, ctx));
  } catch (e) {
    console.error(e);
    return withCors(json({ ok: false, error: "Internal server error.", detail: env.ENVIRONMENT === "development" ? String(e?.message || e) : void 0 }, 500));
  }
} };
export {
  index_default as default
};

