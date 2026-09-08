/** Shared specification and independent acceptance oracle for real-model coding. */
import { mkdir, readFile, writeFile, readdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { createHash } from 'node:crypto';

const buildSpec = `# Inventory and order library — build phase

Implement a dependency-free Node.js ESM library in src/inventory.mjs, with supporting
modules in src/, tests in test/inventory.test.mjs, and README.md usage examples.
Export Inventory and InventoryError from src/inventory.mjs. Use native node:test.
InventoryError extends Error and exposes a stable string .code. No network or packages.

Identifiers: SKU matches /^[A-Za-z0-9_-]{1,40}$/; order ID matches
/^[A-Za-z0-9_-]{1,64}$/. Quantities and all stock totals are safe integers;
stock may be zero, requested quantity must be strictly positive. Never coerce strings,
NaN, Infinity, negative quantities, fractions, or unsafe integers. Invalid input raises
InventoryError code INVALID_INPUT. All failed operations leave every observable state
unchanged, including not consuming an ID. Validate every line before mutating anything.

new Inventory(initialStock): initialStock is a plain object mapping valid SKU to
nonnegative stock; missing argument means {}. Copy caller-owned data. Invalid input
throws INVALID_INPUT. getStock(sku) returns a detached object
{onHand, reserved, available}; available = onHand - reserved. Unknown valid SKU throws
UNKNOWN_SKU. onHand is physical stock; reservation holds do not reduce onHand.

reserve(id, lines): lines is a nonempty array of exactly {sku, quantity} data.
Combine duplicate SKU lines by sum, reject unsafe sums, and sort normalized lines by
SKU lexicographically. Unknown SKU throws UNKNOWN_SKU. Insufficient available stock
for ANY normalized line throws INSUFFICIENT_STOCK with NO partial reservations.
On success hold all requested units and return detached receipt
{id, status:'reserved', lines:[{sku,quantity},...]}. The caller may mutate input and
returned arrays without changing library state.

Order ID replay: reserve with an existing ID and the same normalized lines returns
its CURRENT detached receipt without reserving again, even after commit or cancel.
Same ID with different normalized lines throws ID_CONFLICT and changes nothing.
getOrder(id) returns a detached receipt, or null for unknown valid ID.

commit(id): unknown ID throws UNKNOWN_ORDER. For reserved orders, subtract each held
quantity from onHand, release its hold, set status committed, return detached receipt.
Repeated commit of committed ID returns the same logical receipt without another
decrement. Commit of cancelled ID throws INVALID_STATE.
cancel(id): unknown ID throws UNKNOWN_ORDER. For reserved orders release holds, set
status cancelled and return receipt. Repeated cancel of cancelled ID is idempotent.
Cancel of committed ID throws INVALID_STATE. All bad IDs throw INVALID_INPUT.

snapshot(): return detached, JSON-serializable canonical data:
{version:1, stock:{sku:onHand,...}, orders:[{id,status,lines},...]}. Stock keys sorted
lexicographically; orders sorted by ID; normalized lines sorted by SKU. Include terminal
orders to preserve ID replay semantics. Order status is reserved|committed|cancelled.
Inventory.fromSnapshot(data): static method, validate structure, supported version,
identifiers, safe counts, unique order IDs, normalized positive lines, valid status,
known SKUs, and total active reservations <= onHand for each SKU. Malformed snapshots
throw INVALID_SNAPSHOT (an InventoryError) without coercion. Copy data and rebuild
reservation totals. Restoration must preserve behavior and replay. No hidden I/O.

Deliver genuine implementation and regression tests, not a stub with hardcoded cases.
At least two implementation modules. Document errors and each replay/atomicity rule.
`;

const extendSpec = `# Incremental requirements — extend phase

Keep every build-phase API rule and test passing. Add inventory replenishment and
reservation expiry, with deterministic clock handling and snapshot compatibility.

restock(opId, lines): opId follows the order ID syntax but uses a SEPARATE namespace.
lines uses the same normalization/positive-safe-integer rules as reserve. Only known
SKUs are allowed. Atomically increase onHand; an unsafe resulting stock total throws
INVALID_INPUT before any change. Successful return:
{opId, applied:true, lines:[{sku,quantity},...]}. Repeating the same opId and normalized
lines returns that receipt without adding stock again; changed lines throw ID_CONFLICT.
Failed calls do not consume the opId. Copy inputs and returned values.

reserve(id, lines, options): optional options is a plain object whose expiresAt is
null/omitted or a nonnegative safe integer timestamp. Default is null. Receipt now
includes expiresAt (including null). Existing-ID comparison includes normalized
expiresAt; different deadline means ID_CONFLICT. No implicit clock and no auto-expiry.
Invalid options/deadline throw INVALID_INPUT with no state change.
expire(now): now must be a nonnegative safe integer, else INVALID_INPUT. In one
operation release all RESERVED orders whose non-null expiresAt <= now, mark expired,
return their IDs sorted lexicographically. Committed/cancelled/expired are unaffected.
Repeating expire is a no-op returning []. commit/cancel of expired orders throws
INVALID_STATE; replaying reserve of expired order returns expired and never re-holds.

snapshot() now outputs version:2, stock, orders (each has expiresAt), and
restocks:[{opId,lines},...] sorted by opId. Preserve restock replay after reload.
fromSnapshot accepts valid v1 snapshots (orders get expiresAt:null, restocks empty)
and valid v2 snapshots. Reject invalid deadlines, duplicate restock IDs, malformed
restock lines, unknown SKUs, unsafe quantities, and invalid order status with
INVALID_SNAPSHOT. Restock entries are a replay ledger and MUST NOT be re-applied to
already-restocked snapshot stock. v1 only permits original three statuses; v2 also
permits expired. Preserve original JSON input from caller mutation.

Implement and test each new rule plus interactions: reserved stock + restock,
commit before expiry, one expired and one active reservation, replay after snapshot,
and failed mixed-SKU restock/reservation followed by successful retry with same ID.
`;

const packageSource = { name: 'inventory-conversation-probe', private: true, type: 'module', scripts: { test: 'node --test test/*.test.mjs' } };

export async function prepareCodingWorkspace(directory, runId) {
  const workspace = resolve(directory);
  await mkdir(join(workspace, 'src'), { recursive: true });
  await mkdir(join(workspace, 'test'), { recursive: true });
  await writeFile(join(workspace, 'package.json'), `${JSON.stringify(packageSource, null, 2)}\n`);
  await writeFile(join(workspace, 'SPEC-build.md'), buildSpec);
  await writeFile(join(workspace, 'AGENTS.md'), `This is an isolated coding benchmark workspace. Read the active SPEC files, implement the actual library, and run genuine tests. Do not modify SPEC files or the package test command. Do not simulate tool execution or claim unrun checks passed. Keep the implementation dependency-free. All work stays under /workspace.\n`);
  return { workspace, runId, specHashes: { build: createHash('sha256').update(buildSpec).digest('hex'), extend: createHash('sha256').update(extendSpec).digest('hex') } };
}

export async function prepareCodingPhase(directory, phase) {
  if (phase === 'extend') await writeFile(join(resolve(directory), 'SPEC-extend.md'), extendSpec);
}

export function codingPrompt(phase, runId) {
  const work = phase === 'build'
    ? `Build the inventory/order library in SPEC-build.md. Work through these implementation milestones and inspect each tool result before proceeding: (1) read the complete specification and inventory the workspace; (2) design the module boundaries and public contracts; (3) implement errors and strict input normalization in a supporting module; (4) implement reservation accounting and atomic preflight; (5) implement commit/cancel and ID replay behavior; (6) implement detached queries and snapshot/reload validation; (7) write regression tests for success paths; (8) add independent edge-case tests for malformed inputs, duplicate IDs, multi-SKU failures, and mutated caller data; (9) run the full tests and fix failures; (10) review implementation against every requirement and write a README with actual examples. At least two src modules must be real implementation. Do not combine these milestones into one generated shell script; use actual Read/Write/Edit/Bash tools and inspect results. Complete all milestones in this turn.`
    : phase === 'extend'
      ? `Continue the same inventory coding session; preserve the existing working implementation. Read SPEC-extend.md and re-read the relevant existing modules and tests. Implement these milestones separately: (1) add atomic and idempotent restock; (2) test overflow, mixed-SKU failure, and successful retry with same ID; (3) extend reserve with deterministic deadlines and implement expire; (4) test all terminal-state interactions and detached options/receipts; (5) migrate snapshots to v2 and accept v1; (6) test restock replay and reservation state through JSON round trips; (7) run the full previous and new suite, fixing actual failures; (8) review and update README examples. Keep build-phase behavior intact. Inspect each tool result before the next milestone.`
      : `Audit and finish the SAME inventory/order implementation. Re-read SPEC-build.md and SPEC-extend.md, then inspect every implementation module and the test coverage. Add regression tests for at least these interactions: reserve multi-SKU atomic failure then reuse ID; terminal-order replay after JSON snapshot reload; restock replay with reordered duplicate SKU lines; expire one reservation while another remains active; unsafe integer overflow before any stock mutation. Run the full test suite and at least one executable README example. Fix any discrepancies you find and run the affected checks again. Inspect actual tool output before claiming success. This is a real end-to-end coding audit, not a summary-only turn.`;
  return `K2C_LONG_PROBE ${runId} LONG_PHASE:${phase}. ${work} Keep all files under /workspace, use no network or dependencies, and never modify SPEC files. Report the exact commands you actually ran, observed test counts/failures, any unresolved issues, and changed files. If genuinely complete, end your answer with CODING_PHASE_DONE:${phase}. A marker alone is not evidence: separate hidden acceptance checks will verify the implementation.`;
}

// The oracle is delivered directly to a separate Node process over stdin, outside
// the model workspace. Tests were authored from the API contract before any model
// implementation exists. They exercise public behavior and snapshot invariants.
export function acceptanceSource(phase) {
  return `import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
const phase = ${JSON.stringify(phase)};
const checks = [], failures = [];
let Inventory, InventoryError;
try { ({Inventory, InventoryError} = await import(pathToFileURL('/workspace/src/inventory.mjs'))); }
catch (error) { console.log(JSON.stringify({phase,passed:false,checks:[],failures:[{name:'module import',error:String(error),stack:error.stack}]})); process.exit(1); }
function test(name, fn) { try { fn(); checks.push(name); } catch(error) { failures.push({name,error:String(error),stack:error.stack}); } }
function code(fn, expected) { assert.throws(fn, e => e instanceof InventoryError && e.code === expected); }
function stock(i, sku, onHand, reserved) { assert.deepEqual(i.getStock(sku), {onHand,reserved,available:onHand-reserved}); }
function lines(...pairs) { return pairs.map(([sku,quantity])=>({sku,quantity})); }
const clone = x => JSON.parse(JSON.stringify(x));
const snap = i => JSON.stringify(i.snapshot());
const atomic = (i,fn,error) => {const before=snap(i);code(fn,error);assert.equal(snap(i),before);};
test('exports and empty inventory',()=>{assert.equal(typeof Inventory,'function');assert.equal(typeof InventoryError,'function');assert.equal(new Inventory().getOrder('absent'),null);});
for (const value of [-1,0.5,'3',NaN,Infinity,Number.MAX_SAFE_INTEGER+1,null]) test('invalid initial stock '+String(value),()=>code(()=>new Inventory({A:value}),'INVALID_INPUT'));
test('invalid initial shapes',()=>{for(const x of [null,[],3,'x'])code(()=>new Inventory(x),'INVALID_INPUT');for(const sku of ['', 'bad sku','x'.repeat(41)])code(()=>new Inventory({[sku]:1}),'INVALID_INPUT');});
test('zero stock and unknown SKU',()=>{const i=new Inventory({A:0});stock(i,'A',0,0);code(()=>i.getStock('B'),'UNKNOWN_SKU');code(()=>i.getStock(''),'INVALID_INPUT');});
test('constructor copies stock',()=>{const initial={A:9};const i=new Inventory(initial);initial.A=1;stock(i,'A',9,0);});
test('normalize duplicate lines and detached receipt',()=>{const i=new Inventory({A:10,B:10});const input=lines(['B',2],['A',1],['A',3]);const r=i.reserve('order',input);assert.deepEqual(r.lines,lines(['A',4],['B',2]));assert.equal(r.status,'reserved');input[0].quantity=9;r.lines[0].quantity=100;stock(i,'A',10,4);stock(i,'B',10,2);assert.equal(i.getOrder('order').lines[0].quantity,4);});
test('available stock considers existing holds',()=>{const i=new Inventory({A:5});i.reserve('a',lines(['A',3]));atomic(i,()=>i.reserve('b',lines(['A',3])),'INSUFFICIENT_STOCK');i.reserve('b',lines(['A',2]));stock(i,'A',5,5);});
test('multi SKU insufficient is atomic and ID reusable',()=>{const i=new Inventory({A:9,B:2});atomic(i,()=>i.reserve('x',lines(['A',4],['B',3])),'INSUFFICIENT_STOCK');assert.equal(i.getOrder('x'),null);i.reserve('x',lines(['A',4],['B',2]));stock(i,'A',9,4);stock(i,'B',2,2);});
test('unknown SKU reservation is atomic',()=>{const i=new Inventory({A:9});atomic(i,()=>i.reserve('x',lines(['A',4],['B',1])),'UNKNOWN_SKU');stock(i,'A',9,0);});
for(const value of [0,-1,1.5,'2',NaN,Infinity,Number.MAX_SAFE_INTEGER+1]) test('invalid reserve quantity '+String(value),()=>{const i=new Inventory({A:9});atomic(i,()=>i.reserve('x',lines(['A',value])),'INVALID_INPUT');});
test('invalid lines and identifiers',()=>{const i=new Inventory({A:9});for(const v of [null,{},[],[null],[{}],[{sku:'A'}]])atomic(i,()=>i.reserve('x',v),'INVALID_INPUT');for(const id of ['', 'bad id','x'.repeat(65),null])code(()=>i.reserve(id,lines(['A',1])),'INVALID_INPUT');});
test('duplicate line sum overflow rejected atomically',()=>{const i=new Inventory({A:Number.MAX_SAFE_INTEGER});atomic(i,()=>i.reserve('x',lines(['A',Number.MAX_SAFE_INTEGER],['A',1])),'INVALID_INPUT');});
test('equivalent reservation replay and conflict',()=>{const i=new Inventory({A:9,B:9});i.reserve('x',lines(['A',2],['B',3]));const before=snap(i);const r=i.reserve('x',lines(['B',1],['A',2],['B',2]));assert.equal(r.status,'reserved');assert.equal(snap(i),before);atomic(i,()=>i.reserve('x',lines(['A',3],['B',3])),'ID_CONFLICT');});
test('commit exactly once and terminal reserve replay',()=>{const i=new Inventory({A:8});i.reserve('x',lines(['A',3]));assert.equal(i.commit('x').status,'committed');stock(i,'A',5,0);i.commit('x');i.reserve('x',lines(['A',3]));stock(i,'A',5,0);atomic(i,()=>i.cancel('x'),'INVALID_STATE');});
test('cancel exactly once and terminal reserve replay',()=>{const i=new Inventory({A:8});i.reserve('x',lines(['A',3]));assert.equal(i.cancel('x').status,'cancelled');i.cancel('x');i.reserve('x',lines(['A',3]));stock(i,'A',8,0);atomic(i,()=>i.commit('x'),'INVALID_STATE');});
test('unknown order operations and invalid IDs',()=>{const i=new Inventory({A:8});code(()=>i.commit('x'),'UNKNOWN_ORDER');code(()=>i.cancel('x'),'UNKNOWN_ORDER');for(const fn of ['getOrder','commit','cancel'])code(()=>i[fn]('bad id'),'INVALID_INPUT');});
test('query values are detached',()=>{const i=new Inventory({A:8});i.reserve('x',lines(['A',3]));const s=i.getStock('A');s.onHand=0;const o=i.getOrder('x');o.status='committed';o.lines.length=0;stock(i,'A',8,3);assert.equal(i.getOrder('x').status,'reserved');});
test('canonical snapshot ordering and no aliasing',()=>{const i=new Inventory({Z:9,A:9});i.reserve('z',lines(['Z',2],['A',1]));i.reserve('a',lines(['Z',1]));const s=i.snapshot();assert.deepEqual(Object.keys(s.stock),['A','Z']);assert.deepEqual(s.orders.map(x=>x.id),['a','z']);assert.deepEqual(s.orders[1].lines.map(x=>x.sku),['A','Z']);s.stock.Z=0;s.orders[0].lines[0].quantity=9;stock(i,'Z',9,3);});
test('JSON reload preserves holds, terminal orders and replay',()=>{const i=new Inventory({A:20,B:10});i.reserve('held',lines(['A',3],['B',2]));i.reserve('sold',lines(['A',4]));i.commit('sold');i.reserve('cancelled',lines(['B',1]));i.cancel('cancelled');const raw=clone(i.snapshot());const j=Inventory.fromSnapshot(raw);assert.deepEqual(j.snapshot(),i.snapshot());raw.stock.A=0;stock(j,'A',16,3);j.commit('sold');j.reserve('sold',lines(['A',4]));stock(j,'A',16,3);j.commit('held');stock(j,'A',13,0);stock(j,'B',8,0);});
test('v1 supported and detached on restoration',()=>{const raw={version:1,stock:{A:10},orders:[{id:'x',status:'reserved',lines:lines(['A',3])}]};const i=Inventory.fromSnapshot(raw);raw.orders[0].lines[0].quantity=9;stock(i,'A',10,3);i.commit('x');stock(i,'A',7,0);});
const invalidSnapshots=[null,{}, {version:99,stock:{},orders:[]},{version:1,stock:{A:-1},orders:[]},{version:1,stock:{A:2},orders:[{id:'x',status:'reserved',lines:lines(['A',3])}]},{version:1,stock:{A:5},orders:[{id:'x',status:'weird',lines:lines(['A',1])}]},{version:1,stock:{A:5},orders:[{id:'x',status:'reserved',lines:lines(['B',1])}]},{version:1,stock:{A:5},orders:[{id:'x',status:'reserved',lines:lines(['A',1])},{id:'x',status:'cancelled',lines:lines(['A',1])}]}];
invalidSnapshots.forEach((s,index)=>test('reject malformed snapshot '+index,()=>code(()=>Inventory.fromSnapshot(s),'INVALID_SNAPSHOT')));
test('combined reserved totals validation',()=>code(()=>Inventory.fromSnapshot({version:1,stock:{A:5},orders:[{id:'x',status:'reserved',lines:lines(['A',3])},{id:'y',status:'reserved',lines:lines(['A',3])}]}),'INVALID_SNAPSHOT'));
if(phase!=='build'){
test('restock normalize, replay, separate ID namespace',()=>{const i=new Inventory({A:5,B:1});i.reserve('same',lines(['A',2]));const r=i.restock('same',lines(['B',1],['A',2],['B',2]));assert.deepEqual(r,{opId:'same',applied:true,lines:lines(['A',2],['B',3])});stock(i,'A',7,2);stock(i,'B',4,0);i.restock('same',lines(['A',2],['B',3]));stock(i,'A',7,2);atomic(i,()=>i.restock('same',lines(['A',3])),'ID_CONFLICT');});
test('restock failures atomic and op ID reusable',()=>{const i=new Inventory({A:4,B:Number.MAX_SAFE_INTEGER});atomic(i,()=>i.restock('x',lines(['A',2],['B',1])),'INVALID_INPUT');atomic(i,()=>i.restock('x',lines(['A',2],['Z',1])),'UNKNOWN_SKU');i.restock('x',lines(['A',2]));stock(i,'A',6,0);});
test('restock input and receipt detached',()=>{const i=new Inventory({A:1});const l=lines(['A',2]);const r=i.restock('x',l);l[0].quantity=4;r.lines[0].quantity=4;i.restock('x',lines(['A',2]));stock(i,'A',3,0);});
test('default expiry and exact replay deadline',()=>{const i=new Inventory({A:10});assert.equal(i.reserve('none',lines(['A',1])).expiresAt,null);i.reserve('x',lines(['A',2]),{expiresAt:100});atomic(i,()=>i.reserve('x',lines(['A',2]),{expiresAt:101}),'ID_CONFLICT');assert.equal(i.reserve('x',lines(['A',2]),{expiresAt:100}).expiresAt,100);});
for(const deadline of [-1,0.5,'100',NaN,Infinity,Number.MAX_SAFE_INTEGER+1])test('bad expiry '+String(deadline),()=>{const i=new Inventory({A:10});atomic(i,()=>i.reserve('x',lines(['A',1]),{expiresAt:deadline}),'INVALID_INPUT');atomic(i,()=>i.expire(deadline),'INVALID_INPUT');});
test('invalid expiry options shape',()=>{const i=new Inventory({A:10});for(const options of [null,[],3,'x'])atomic(i,()=>i.reserve('x',lines(['A',1]),options),'INVALID_INPUT');});
test('expiry boundary, sorted IDs, and no implicit clock',()=>{const i=new Inventory({A:20});i.reserve('z',lines(['A',2]),{expiresAt:10});i.reserve('a',lines(['A',3]),{expiresAt:10});i.reserve('later',lines(['A',4]),{expiresAt:11});i.reserve('none',lines(['A',1]));stock(i,'A',20,10);assert.deepEqual(i.expire(9),[]);assert.deepEqual(i.expire(10),['a','z']);stock(i,'A',20,5);assert.deepEqual(i.expire(10),[]);assert.equal(i.getOrder('a').status,'expired');assert.equal(i.reserve('a',lines(['A',3]),{expiresAt:10}).status,'expired');stock(i,'A',20,5);atomic(i,()=>i.commit('a'),'INVALID_STATE');atomic(i,()=>i.cancel('a'),'INVALID_STATE');});
test('committed and cancelled orders do not expire',()=>{const i=new Inventory({A:10});i.reserve('sold',lines(['A',2]),{expiresAt:1});i.commit('sold');i.reserve('cancelled',lines(['A',2]),{expiresAt:1});i.cancel('cancelled');assert.deepEqual(i.expire(100),[]);stock(i,'A',8,0);});
test('zero deadline and max safe deadline',()=>{const i=new Inventory({A:4});i.reserve('zero',lines(['A',1]),{expiresAt:0});i.reserve('max',lines(['A',1]),{expiresAt:Number.MAX_SAFE_INTEGER});assert.deepEqual(i.expire(0),['zero']);stock(i,'A',4,1);});
test('v2 snapshot replay ledger not re-applied',()=>{const i=new Inventory({A:10,B:5});i.restock('z',lines(['A',3]));i.restock('a',lines(['B',2]));i.reserve('held',lines(['A',2]),{expiresAt:4});const s=i.snapshot();assert.equal(s.version,2);assert.deepEqual(s.restocks.map(x=>x.opId),['a','z']);const j=Inventory.fromSnapshot(clone(s));stock(j,'A',13,2);j.restock('z',lines(['A',3]));stock(j,'A',13,2);assert.deepEqual(j.expire(4),['held']);assert.equal(j.reserve('held',lines(['A',2]),{expiresAt:4}).status,'expired');stock(j,'A',13,0);});
test('v1 migration defaults',()=>{const j=Inventory.fromSnapshot({version:1,stock:{A:5},orders:[{id:'x',status:'reserved',lines:lines(['A',2])}]});assert.equal(j.getOrder('x').expiresAt,null);assert.equal(j.snapshot().version,2);assert.deepEqual(j.snapshot().restocks,[]);assert.deepEqual(j.expire(Number.MAX_SAFE_INTEGER),[]);});
test('bad v2 snapshots rejected',()=>{const i=new Inventory({A:10});i.restock('op',lines(['A',2]));i.reserve('x',lines(['A',2]),{expiresAt:4});const base=i.snapshot();for(const change of [s=>s.orders[0].expiresAt=-1,s=>s.orders[0].expiresAt='4',s=>s.restocks.push(clone(s.restocks[0])),s=>s.restocks[0].lines[0].quantity=0,s=>s.restocks[0].lines[0].sku='Z',s=>s.orders[0].status='ghost']){const s=clone(base);change(s);code(()=>Inventory.fromSnapshot(s),'INVALID_SNAPSHOT');}});
test('expired snapshot retains terminal semantics',()=>{const i=new Inventory({A:10});i.reserve('x',lines(['A',2]),{expiresAt:1});i.expire(1);const j=Inventory.fromSnapshot(clone(i.snapshot()));assert.equal(j.getOrder('x').status,'expired');atomic(j,()=>j.commit('x'),'INVALID_STATE');stock(j,'A',10,0);});
}
console.log(JSON.stringify({phase,passed:failures.length===0,passedCount:checks.length,failedCount:failures.length,checks,failures}));
process.exitCode=failures.length?1:0;
`;
}

export async function snapshotCodingWorkspace(directory) {
  const root = resolve(directory), files = [];
  async function visit(dir) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (entry.name === '.git' || entry.name === 'node_modules') continue;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile()) { const bytes = await readFile(path); files.push({path:path.slice(root.length+1),bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')}); }
    }
  }
  await visit(root);
  return {files:files.sort((a,b)=>a.path.localeCompare(b.path))};
}

/** Read-only artifact-contract checks; separate from the public API oracle. */
export async function verifyCodingWorkspace(directory, phase) {
  const root = resolve(directory);
  const snapshot = await snapshotCodingWorkspace(root);
  const violations = [];
  const text = path => readFile(join(root,path),'utf8').catch(()=>null);
  if(await text('SPEC-build.md')!==buildSpec)violations.push('SPEC-build.md changed or missing');
  if(phase!=='build'&&await text('SPEC-extend.md')!==extendSpec)violations.push('SPEC-extend.md changed or missing');
  const packageText=await text('package.json');
  let pkg;try{pkg=JSON.parse(packageText);}catch{/* reported below */}
  if(pkg?.scripts?.test!==packageSource.scripts.test)violations.push('package test command changed or missing');
  const sourceModules=snapshot.files.filter(file=>/^src\/.+\.mjs$/.test(file.path)&&file.bytes>0);
  if(sourceModules.length<2)violations.push('fewer than two nonempty implementation modules');
  if(!snapshot.files.some(file=>file.path==='test/inventory.test.mjs'&&file.bytes>0))violations.push('test/inventory.test.mjs missing or empty');
  if(!snapshot.files.some(file=>file.path==='README.md'&&file.bytes>0))violations.push('README.md missing or empty');
  return {passed:violations.length===0,violations,sourceModules,snapshot};
}

/** Offline aggregation across recording segments; never contacts a provider. */
export async function aggregateCodingEvidence(directory) {
  const root=resolve(directory),result=JSON.parse(await readFile(join(root,'result.json'),'utf8'));
  const segments=result.segments??[{id:result.runId,parentRunId:null,wireFile:join(root,'wire.json')}];
  const violations=[],wires=[],seenRuns=new Set(),requests=[];
  for(const [index,segment]of segments.entries()){
    if(seenRuns.has(segment.id))violations.push(`duplicate recording segment ${segment.id}`);
    seenRuns.add(segment.id);
    if(index&&segment.parentRunId!==segments[index-1].id)violations.push(`segment ${segment.id} does not name the previous parent run`);
    const filename=segment.id===result.runId?join(root,'wire.json'):segment.wireFile??join(root,'segments',segment.id,'wire.json');
    const wire=JSON.parse(await readFile(filename,'utf8'));
    if(wire.id!==segment.id)violations.push(`wire ID differs for segment ${segment.id}`);
    wires.push({segment,wire,filename});
    for(const record of wire.requests)requests.push({segmentId:segment.id,request:record,logicalOrdinal:requests.length+1});
  }
  const parseJsonl=text=>text.split('\n').flatMap(line=>{try{return[JSON.parse(line)];}catch{return[]}});
  const transcript=result.transcript?parseJsonl(await readFile(result.transcript,'utf8')):[];
  const uses=new Map(),receipts=new Map(),seenEntries=new Set();
  for(const entry of transcript){
    if(entry.uuid&&seenEntries.has(entry.uuid))continue;
    if(entry.uuid)seenEntries.add(entry.uuid);
    for(const block of Array.isArray(entry.message?.content)?entry.message.content:[]){
      if(block.type==='tool_use')uses.set(block.id,block);
      if(block.type==='tool_result')receipts.set(block.tool_use_id,block);
    }
  }
  const findBlocks=(value,type,out=[])=>{
    if(Array.isArray(value))for(const item of value)findBlocks(item,type,out);
    else if(value&&typeof value==='object'){
      if(value.type===type)out.push(value);
      for(const item of Object.values(value))findBlocks(item,type,out);
    }
    return out;
  };
  const mismatches=[];let clientReceiptChecks=0,clientToolChecks=0;
  const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
  for(const {segmentId,request,logicalOrdinal}of requests){
    for(const block of findBlocks(request.request?.messages,'tool_result')){
      clientReceiptChecks++;
      const original=receipts.get(block.tool_use_id);
      if(!original||JSON.stringify(original.content)!==JSON.stringify(block.content)||Boolean(original.is_error)!==Boolean(block.is_error))mismatches.push({segmentId,requestId:request.id,logicalOrdinal,kind:'tool_result',id:block.tool_use_id,canonicalExists:Boolean(original),canonicalHash:original?hash([original.content,Boolean(original.is_error)]):null,requestHash:hash([block.content,Boolean(block.is_error)])});
    }
    for(const block of findBlocks(request.request?.messages,'tool_use')){
      clientToolChecks++;
      const original=uses.get(block.id);
      if(!original||JSON.stringify([original.name,original.input])!==JSON.stringify([block.name,block.input]))mismatches.push({segmentId,requestId:request.id,logicalOrdinal,kind:'tool_use',id:block.id,canonicalExists:Boolean(original)});
    }
  }
  const roundChecks=[];
  for(const [index,round]of result.rounds.entries()){
    const label=round.label??round.phase,providerRunId=round.providerRunId??segments[0].id;
    if(!seenRuns.has(providerRunId))violations.push(`round ${index+1} refers to missing provider segment ${providerRunId}`);
    const events=parseJsonl(await readFile(join(root,`${index+1}-${label}.jsonl`),'utf8'));
    const sessionIds=[...new Set(events.map(event=>event.session_id).filter(Boolean))];
    if(sessionIds.length!==1||sessionIds[0]!==result.sessionId)violations.push(`round ${index+1} did not report exactly the original session ID`);
    const contract=await verifyCodingWorkspace(join(root,`${index+1}-${label}-snapshot`),round.phase);
    roundChecks.push({index:index+1,phase:round.phase,label,providerRunId,sessionIds,exitCode:round.exitCode,timedOut:round.timedOut,independentApiPassed:round.independentPassed,acceptancePassedCount:round.acceptance?.verdict?.passedCount,acceptanceFailedCount:round.acceptance?.verdict?.failedCount,artifactContract:{passed:contract.passed,violations:contract.violations}});
  }
  const native=requests.flatMap(item=>item.request.upstreamRequests??[]).flatMap(attempt=>attempt.eventsSummary??[]).filter(event=>event.kind==='ReasoningContent');
  return {sessionId:result.sessionId,recordingSegmentCount:segments.length,segments:wires.map(({segment,wire})=>({id:segment.id,parentRunId:segment.parentRunId,scenario:segment.scenario??result.scenario,registrationScenario:segment.registrationScenario??wire.scenario,serverBase:segment.serverBase})),totalMainHttpRequests:requests.length,totalLogicalUpstreamCalls:wires.reduce((sum,item)=>sum+(item.wire.state?.liveProbe?.realUpstreamCalls??0),0),probeBudgetRejections:requests.filter(item=>(item.request.upstreamRequests??[]).some(attempt=>attempt.budgetExceeded)).map(item=>({segmentId:item.segmentId,requestId:item.request.id,logicalOrdinal:item.logicalOrdinal})),nativeReasoningFrames:native.length,nativeReasoningTextBytes:native.reduce((sum,event)=>sum+(event.textBytes??0),0),canonicalToolCalls:uses.size,canonicalToolResults:receipts.size,unmatchedCanonicalTools:[...uses.keys()].filter(id=>!receipts.has(id)),unmatchedCanonicalResults:[...receipts.keys()].filter(id=>!uses.has(id)),clientToolChecks,clientReceiptChecks,clientCanonicalMismatches:mismatches,roundChecks,invariantViolations:violations,passed:violations.length===0&&mismatches.length===0,scope:'All recording segments and every stored CLI round are included. This checks that tool calls/results actually sent by the client match the canonical same-session transcript; it does not claim old receipts remain verbatim after compaction or prove gateway-to-Kiro equivalence.'};
}
