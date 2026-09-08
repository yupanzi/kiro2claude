/** Real Claude Code coding a multi-file library in one three-turn session. */
import { spawn, execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile, readdir, cp, access, rename } from 'node:fs/promises';
import { watch } from 'node:fs';
import { resolve, join } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { prepareCodingWorkspace, prepareCodingPhase, codingPrompt, acceptanceSource, snapshotCodingWorkspace, verifyCodingWorkspace, aggregateCodingEvidence } from './_live-coding-workspace.mjs';

const base = process.env.K2C_PROBE_BASE ?? 'http://127.0.0.1:18943';
const dockerBase = process.env.K2C_PROBE_DOCKER_BASE ?? 'http://host.docker.internal:18943';
const image = process.env.K2C_CLAUDE_IMAGE ?? 'kiro2claude-cc:validation-latest';
const model = process.env.K2C_CODING_MODEL ?? 'claude-opus-5';
const reportDir = resolve(process.env.K2C_CODING_REPORT_DIR ?? 'test-results/conversation-integrity-2026-09-07/coding');
const scenarios = (process.env.K2C_PROBE_SCENARIOS ?? 'live-baseline,live-mixed').split(',');
const timeoutMs = Number(process.env.K2C_CODING_PHASE_TIMEOUT_MS ?? 1_200_000);
const resumeExisting = process.env.K2C_CODING_RESUME_EXISTING === '1';
const newSegment = process.env.K2C_CODING_NEW_SEGMENT === '1';
const registrationScenarioOverride = process.env.K2C_CODING_REGISTRATION_SCENARIO;
if(newSegment&&!resumeExisting)throw new Error('NEW_SEGMENT requires RESUME_EXISTING so the same session and workspace are preserved.');
const phases = ['build', 'extend', 'audit'];
await mkdir(reportDir, { recursive: true });
const version = execFileSync('docker', ['run', '--rm', '--entrypoint', 'cat', image, '/etc/cc-version'], { encoding: 'utf8' }).trim();

function jsonl(text) { return text.split('\n').flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } }); }
async function command(args, { input, timeout = timeoutMs, onTimeout } = {}) {
  const started = Date.now();
  const child = spawn('docker', args, { stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'] });
  let stdout = '', stderr = '', timedOut = false;
  if (input !== undefined) child.stdin.end(input);
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.on('data', chunk => { stderr += chunk; });
  const timer = setTimeout(() => { timedOut = true; onTimeout?.(); child.kill('SIGTERM'); }, timeout);
  const exitCode = await new Promise((accept, reject) => { child.once('error', reject); child.once('close', accept); });
  clearTimeout(timer);
  return { exitCode, timedOut, durationMs: Date.now() - started, stdout, stderr };
}

async function findTranscript(directory, sessionId) {
  for (const entry of await readdir(directory, { withFileTypes: true }).catch(() => [])) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) { const found = await findTranscript(path, sessionId); if (found) return found; }
    else if (entry.name === `${sessionId}.jsonl`) return path;
  }
}

function transcriptAudit(entries, wire) {
  const uses = [], results = [];
  const seen = new Set();
  for (const entry of entries) {
    if (entry.uuid && seen.has(entry.uuid)) continue;
    seen.add(entry.uuid);
    for (const block of Array.isArray(entry.message?.content) ? entry.message.content : []) {
      if (block.type === 'tool_use') uses.push({ id: block.id, name: block.name, input: block.input, timestamp: entry.timestamp, messageId: entry.message.id });
      if (block.type === 'tool_result') results.push({ id: block.tool_use_id, isError: block.is_error, content: block.content, timestamp: entry.timestamp });
    }
  }
  const signatures = new Map();
  for (const use of uses) {
    const signature = createHash('sha256').update(JSON.stringify({ name: use.name, input: use.input })).digest('hex');
    signatures.set(signature, [...(signatures.get(signature) ?? []), use]);
  }
  const toolIdSet = new Set(uses.map(use => use.id)), resultIdSet = new Set(results.map(result => result.id));
  const nativeReasoning = wire.requests.flatMap(request => request.upstreamRequests ?? []).flatMap(attempt => (attempt.eventsSummary ?? []).filter(event => event.kind === 'ReasoningContent'));
  return {
    tools: uses, toolResults: results,
    unmatchedTools: uses.filter(use => !resultIdSet.has(use.id)), unmatchedResults: results.filter(result => !toolIdSet.has(result.id)),
    repeatedIdenticalToolPayloads: [...signatures.entries()].filter(([,items]) => items.length > 1).map(([sha256,items]) => ({ sha256, tools: items })),
    repeatedPayloadInterpretation: 'Repeated tests, reads, or identical writes can be intentional. Compare timestamps, wire errors, file hashes, and actual tool results before classifying a duplicate side effect.',
    nativeReasoningFrames: nativeReasoning.length,
    nativeReasoningTextBytes: nativeReasoning.reduce((sum, event) => sum + (event.textBytes ?? 0), 0),
    realUpstreamErrors: wire.requests.flatMap(request => (request.upstreamRequests ?? []).filter(attempt => attempt.error && !attempt.fault).map(attempt => ({request:request.id,phase:request.phase,error:attempt.error}))),
    faults: wire.faults,
  };
}

const results = [];
for (const scenario of scenarios) {
  const dir = join(reportDir, `claude-${scenario}`);
  const existing = resumeExisting ? JSON.parse(await readFile(join(dir,'result.json'),'utf8')) : null;
  // A mixed session may continue in a new no-fault recording segment after
  // its original five injections. Keep the logical case and UUID unchanged.
  const registrationScenario = registrationScenarioOverride ?? (!newSegment ? existing?.registrationScenario : undefined) ?? scenario;
  const runId = existing&&!newSegment ? existing.runId : `claude-coding-${scenario}-${randomUUID().slice(0, 8)}`;
  const sessionId = existing?.sessionId ?? randomUUID();
  const parentRunId = newSegment ? existing.runId : existing?.parentRunId;
  const priorEvidenceSnapshots = [...(existing?.priorEvidenceSnapshots ?? [])];
  if (await access(dir).then(() => true, () => false)) {
    const backup = `${dir}-previous-${Date.now()}`;
    if(existing){await cp(dir,backup,{recursive:true});priorEvidenceSnapshots.push(backup);}
    else await rename(dir,backup);
  }
  const workspace = join(dir, 'workspace');
  const prepared = existing?.prepared ?? await prepareCodingWorkspace(workspace, runId);
  const segments = [...(existing?.segments ?? (existing ? [{id:existing.runId,parentRunId:existing.parentRunId??null,serverBase:existing.serverBase??process.env.K2C_CODING_PARENT_BASE??base,serverBaseSource:existing.serverBase?'prior-result':process.env.K2C_CODING_PARENT_BASE?'explicit-parent-base':'current-base-fallback-for-legacy-result'}] : []))];
  if(newSegment){
    const segmentDir=join(dir,'segments',existing.runId);await mkdir(segmentDir,{recursive:true});
    const oldWire=JSON.parse(await readFile(join(dir,'wire.json'),'utf8'));
    await cp(join(dir,'wire.json'),join(segmentDir,'wire.json'));
    await cp(join(dir,'result.json'),join(segmentDir,'result.json'));
    const priorSegment=segments.find(segment=>segment.id===existing.runId);
    Object.assign(priorSegment,{wireFile:join(segmentDir,'wire.json'),mainRequests:oldWire.requests.length,logicalUpstreamCalls:oldWire.state?.liveProbe?.realUpstreamCalls,budgetExceeded:oldWire.state?.liveProbe?.budgetExceeded});
  }
  if(!existing||newSegment){
    const registration = await fetch(`${base}/probe/runs`, {method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({id:runId,protocol:'claude',scenario:registrationScenario,parentRunId,sessionId})});
    if (!registration.ok) throw new Error(`Register run failed ${registration.status}: ${await registration.text()}`);
    segments.push({id:runId,parentRunId:parentRunId??null,scenario,registrationScenario,serverBase:base,started:new Date().toISOString()});
  }
  await writeFile(join(dir,'segments.json'),`${JSON.stringify({sessionId,segments},null,2)}\n`);
  const container = `k2c-${runId}`, rounds = (existing?.rounds ?? []).map(round=>({...round,providerRunId:round.providerRunId??existing.runId}));
  for(const [index,round]of rounds.entries())round.artifactContract??=await verifyCodingWorkspace(join(dir,`${index+1}-${round.label??round.phase}-snapshot`),round.phase);
  const fileEvents = existing ? JSON.parse(await readFile(join(dir,'filesystem-events.json'),'utf8')) : [];
  const phasePlan = phases.flatMap(phase=>{
    const latest=rounds.findLast(round=>round.phase===phase);
    if(!latest)return[{phase,label:phase}];
    if(latest.timedOut||latest.exitCode!==0||latest.terminal?.is_error!==false)return[{phase,label:`${phase}-continuation`,continuation:true}];
    return[];
  });
  let watcher, started = false, runError;
  const start = Date.now();
  try {
    const create = await command(['run','-d','--rm','--name',container,'--workdir','/workspace',
      '--mount',`type=bind,source=${workspace},target=/workspace`,
      '-e',`ANTHROPIC_BASE_URL=${dockerBase}/run/${runId}/claude`,
      '-e','ANTHROPIC_AUTH_TOKEN=local-coding-probe', '-e','ANTHROPIC_API_KEY=local-coding-probe',
      '-e','DISABLE_NONESSENTIAL_TRAFFIC=1','-e','CLAUDE_CODE_DISABLE_AUTO_MEMORY=1',
      '--entrypoint','sleep',image,'infinity'], {timeout:30_000});
    if (create.exitCode !== 0) throw new Error(create.stderr);
    started = true;
    if(existing){
      const restored=await command(['cp',`${join(dir,'claude-state')}/.`,`${container}:/home/claude/.claude`],{timeout:30_000});
      if(restored.exitCode!==0)throw new Error(`Restore session failed: ${restored.stderr}`);
      const owned=await command(['exec','-u','root',container,'chown','-R','claude:claude','/home/claude/.claude'],{timeout:30_000});
      if(owned.exitCode!==0)throw new Error(`Restore session ownership failed: ${owned.stderr}`);
      await rename(join(dir,'claude-state'),join(dir,`claude-state-before-continuation-${Date.now()}`));
    }
    watcher = watch(workspace, {recursive:true}, (eventType, filename) => {
      if (!filename) return;
      const event = {time:new Date().toISOString(),eventType,path:filename};
      fileEvents.push(event);
      readFile(join(workspace, filename)).then(bytes => Object.assign(event,{bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')})).catch(()=>{});
    });
    for (const planned of phasePlan) {
      const {phase,label}=planned;
      const index=rounds.length;
      await prepareCodingPhase(workspace, phase);
      const prompt = planned.continuation
        ? `K2C_LONG_PROBE ${runId} LONG_PHASE:${phase}. Continue the same ${phase} task from where we left off. Inspect the current files and any prior tool results, finish all remaining work from the active specification, and run the checks needed to give an accurate final report. Do not start the next phase yet. Do not assume a pending operation finished without checking it. Report actual commands, observed results, changed files, and any unresolved issues. When genuinely complete end with CODING_PHASE_DONE:${phase}.`
        : codingPrompt(phase, runId);
      await writeFile(join(dir, `${index + 1}-${label}-prompt.txt`), prompt);
      const args = ['exec',container,'/home/claude/entrypoint.sh','-p',prompt,'--model',model,
        '--output-format','stream-json','--verbose','--include-partial-messages','--max-turns','50',
        '--tools','Read,Write,Edit,Bash','--dangerously-skip-permissions','--effort','high',
        '--debug-file',`/home/claude/.claude/coding-${label}.log`,
        ...(index ? ['--resume',sessionId] : ['--session-id',sessionId])];
      const cli = await command(args, {onTimeout:()=>spawn('docker',['exec',container,'pkill','-TERM','-f','^claude'],{stdio:'ignore'})});
      const events = jsonl(cli.stdout), terminal = events.findLast(event => event.type === 'result');
      const sessionIds = [...new Set(events.map(event => event.session_id).filter(Boolean))];
      const acceptanceText = acceptanceSource(phase);
      // The host initiates this independent oracle over stdin. The model never
      // receives its source; execution remains inside the isolated workspace.
      const acceptance = await command(['exec','-i',container,'node','--input-type=module'], {input:acceptanceText,timeout:60_000});
      const verdict = jsonl(acceptance.stdout).findLast(value => typeof value.passed === 'boolean');
      const snapshot = await snapshotCodingWorkspace(workspace);
      const artifactContract = await verifyCodingWorkspace(workspace,phase);
      const wire = await (await fetch(`${base}/probe/runs/${runId}`)).json();
      await cp(workspace, join(dir, `${index + 1}-${label}-snapshot`), {recursive:true});
      const round = {phase,label,providerRunId:runId,prompt,phaseTimeoutMs:timeoutMs,exitCode:cli.exitCode,timedOut:cli.timedOut,durationMs:cli.durationMs,terminal,sessionIds,
        acceptance:{exitCode:acceptance.exitCode,timedOut:acceptance.timedOut,verdict},snapshot,artifactContract,
        modelClaimedComplete:Boolean(terminal?.result?.includes(`CODING_PHASE_DONE:${phase}`)),
        independentPassed:acceptance.exitCode===0 && !acceptance.timedOut && verdict?.passed===true};
      rounds.push(round);
      await Promise.all([
        writeFile(join(dir,`${index + 1}-${label}.jsonl`),cli.stdout),writeFile(join(dir,`${index + 1}-${label}.stderr`),cli.stderr),
        writeFile(join(dir,`${index + 1}-${label}-acceptance.mjs`),acceptanceText),
        writeFile(join(dir,`${index + 1}-${label}-acceptance.stdout`),acceptance.stdout),writeFile(join(dir,`${index + 1}-${label}-acceptance.stderr`),acceptance.stderr),
        writeFile(join(dir,`${index + 1}-${label}-result.json`),`${JSON.stringify(round,null,2)}\n`),
        writeFile(join(dir,`${index + 1}-${label}-wire.json`),`${JSON.stringify(wire,null,2)}\n`),
      ]);
      console.log(JSON.stringify({protocol:'claude',scenario,runId,phase,label,model,exitCode:cli.exitCode,timedOut:cli.timedOut,
        durationMs:cli.durationMs,modelClaimedComplete:round.modelClaimedComplete,independentPassed:round.independentPassed,
        acceptance:{passed:verdict?.passed,passedCount:verdict?.passedCount,failedCount:verdict?.failedCount,failures:verdict?.failures?.map(failure=>failure.name)},
        upstreamCalls:wire.state?.liveProbe?.realUpstreamCalls,faults:wire.faults?.map(fault=>fault.kind)}));
      if (cli.timedOut || wire.state?.liveProbe?.budgetExceeded) break;
    }
  } catch(error) {runError=error instanceof Error?error.stack:String(error);}
  finally {
    watcher?.close();
    if(started){const copied=await command(['cp',`${container}:/home/claude/.claude`,join(dir,'claude-state')],{timeout:30_000});await writeFile(join(dir,'copy-state.json'),JSON.stringify(copied));await command(['rm','-f',container],{timeout:30_000});}
  }
  const wire = await (await fetch(`${base}/probe/runs/${runId}`)).json();
  const transcript = await findTranscript(join(dir,'claude-state'),sessionId);
  const audit = transcriptAudit(transcript ? jsonl(await readFile(transcript,'utf8')) : [],wire);
  audit.upstreamMetricScope='Current recording segment only; canonical transcript tool counts cover the whole same-session history.';
  const currentSegment=segments.find(segment=>segment.id===runId);
  Object.assign(currentSegment,{wireFile:join(dir,'wire.json'),mainRequests:wire.requests.length,logicalUpstreamCalls:wire.state?.liveProbe?.realUpstreamCalls,budgetExceeded:wire.state?.liveProbe?.budgetExceeded});
  const coversAllPhases=phases.every(phase=>rounds.some(round=>round.phase===phase));
  const sameSession=coversAllPhases&&rounds.every(round=>round.sessionIds.length===1&&round.sessionIds[0]===sessionId);
  const finalIndependentPassed=rounds.at(-1)?.phase==='audit'&&rounds.at(-1)?.independentPassed===true;
  const allPhasesIndependentPassed=coversAllPhases&&rounds.every(round=>round.independentPassed);
  const finalTaskCompleted=sameSession&&phases.every(phase=>{const round=rounds.findLast(round=>round.phase===phase);return round.independentPassed&&round.artifactContract?.passed!==false&&round.exitCode===0&&!round.timedOut&&round.terminal?.is_error===false;});
  const passed=sameSession&&allPhasesIndependentPassed&&rounds.every(round=>round.exitCode===0&&!round.timedOut&&round.terminal?.is_error===false)&&!runError;
  const result={scenario,registrationScenario,runId,parentRunId,serverBase:base,segments,sessionId,version,model,effort:'high',durationMs:(existing?.durationMs??0)+Date.now()-start,prepared,priorEvidenceSnapshots,rounds,runError,sameSession,passed,finalTaskCompleted,allPhasesIndependentPassed,finalIndependentPassed,transcript,audit,
    limitations:['One real-model run per condition is not a measured hallucination rate.','Repeated identical tool payloads are evidence candidates, not automatic duplicate-write failures.','The independent acceptance oracle covers the documented contract cases; passing it does not prove all possible code behavior.']};
  await Promise.all([writeFile(join(dir,'result.json'),`${JSON.stringify(result,null,2)}\n`),writeFile(join(dir,'wire.json'),`${JSON.stringify(wire,null,2)}\n`),writeFile(join(dir,'segments.json'),`${JSON.stringify({sessionId,segments},null,2)}\n`),writeFile(join(dir,'filesystem-events.json'),`${JSON.stringify(fileEvents,null,2)}\n`)]);
  const aggregate=await aggregateCodingEvidence(dir);
  await writeFile(join(dir,'aggregate-evidence.json'),`${JSON.stringify(aggregate,null,2)}\n`);
  result.evidencePassed=aggregate.passed;
  if(!aggregate.passed)result.passed=false;
  await writeFile(join(dir,'result.json'),`${JSON.stringify(result,null,2)}\n`);
  results.push(result);
  console.log(JSON.stringify({protocol:'claude',scenario,registrationScenario,runId,passed:result.passed,sameSession,finalTaskCompleted,finalIndependentPassed,allPhasesIndependentPassed,runError,durationMs:result.durationMs,toolUses:audit.tools.length,toolResults:audit.toolResults.length,nativeReasoningFrames:audit.nativeReasoningFrames,nativeReasoningTextBytes:audit.nativeReasoningTextBytes,upstreamErrors:audit.realUpstreamErrors,faults:audit.faults?.map(fault=>fault.kind)}));
}
const saved=[];
for(const entry of await readdir(reportDir,{withFileTypes:true})){if(!entry.isDirectory()||!entry.name.startsWith('claude-')||/-previous-\d+$/.test(entry.name))continue;const data=await readFile(join(reportDir,entry.name,'result.json'),'utf8').then(JSON.parse,()=>null);if(data)saved.push(data);}
await writeFile(join(reportDir,'claude-coding-results.json'),`${JSON.stringify(saved,null,2)}\n`);
process.exitCode=results.every(result=>result.passed)?0:1;
