export type BizItem = {id:string; name:string; status:string};
export type BizSnapshot = {
  collectedAt:string; toolCount:number; organization?:string; url?:string;
  departments:{id:string;name:string}[]; department:string;
  capabilities:Record<string, 'available'|'unavailable'|'failed'>;
  warnings:string[]; truncated:boolean;
  kpis:(BizItem & {value:number|null; target:number|null; unit:string; targetMax?:number|null; operator:string; window:number|null; measuredAt:string})[];
  objectives:(BizItem & {keyResults:(BizItem & {kpiId:string;value:number|null;target:number|null})[]})[];
  requests:(BizItem & {krId:string;executor:string})[];
  levers:BizItem[];
};

export type BizPlan = {objectiveId:string; name:string; paused:boolean; pending:boolean; checkin:{status:string;expectedAt:string}|null; levers:(BizItem & {krId:string;description:string;hypothesis:string;assignment:string;requests:BizItem[]})[]; decisions:BizItem[]; truncated:boolean};

export type BizStatus = {connected:boolean; method?:'token'|'oauth'; connectedAt?:string; url?:string; login?:string|null; error?:string};
export type BizTeam = {id:string; slug:string; name:string; description:string; version:number|null; agents:number|null; skills:number|null; localVersion:number|null; department:string|null};
export type BizTeams = {teams:BizTeam[]; error?:string};
/** One read for the page: how the project is connected and, when it is, the teams. */
export type BizOverview = {connection?:BizStatus; teams?:BizTeam[]; error?:string};
export type BizTeamPrepared = {team:{id:string;slug:string;nombre:string;version:number}; bots:{name:string;title:string}[]; skills:string[]; commit:string|null; teamB64:string; teamBaseB64:string; error?:string; bot?:string};
/** A department of this project and what synchronizing it with Biz would do (framework D82). */
/** The last change proposal sent for a Biz department and Biz's decision on it. */
export type BizProposal = {id:string; state:"pending"|"accepted"|"rejected"; base:number; reason:string|null; version:number|null};
export type BizDepartmentSync = {department:string; localName:string|null; equipoId:string|null; version:number|null; remoteVersion:number|null;
  state:"absent"|"unpublished"|"synced"|"pull"|"propose"|"proposed"|"rejected"|"renamed"|"conflict"|"pending_apply"; proposal:BizProposal|null;
  /** Delivered by Biz-managed access (connection hook); its changes are made on Biz. */
  managed?:boolean};
export type BizSyncStatus = {publishSupported?:boolean; proposalsSupported?:boolean; departments?:BizDepartmentSync[]; error?:string};
export type BizProposed = {department:string; equipoId:string; proposal:BizProposal; commit:string|null; error?:string};
export type BizPublished = {department:string; equipoId:string; version:number; commit:string|null; error?:string};
export type BotsPlan = {plan:string[]; created:number; changed:number; deleted:number; removalRevision?:string};

/** One of the person's departments in Biz and their role there (display data from /api/panel-access). */
export type BizAccessDepartment = {id:string; name:string; role:{id:string|null; name:string|null; custom:boolean; levels:Record<string,number>}|null; teams:{id:string; name:string}[]};
/** The person's framework freedom: a preset and the level (0-2) of each setting. */
export type BizAccessPolicy = {preset:"cuidado"|"equilibrado"|"libre"|"personalizado"; extensions:number; mcp_servers:number; bots:number; read:number; write:number; shell:number; publish:number; ai:number};
/** `reauthorizeRequired`: Biz cannot recover this old grant's identity, so the person must reconnect Fyso Biz. */
export type BizAccess = {admin:boolean; departments:BizAccessDepartment[]; policy:BizAccessPolicy|null; reauthorizeRequired?:boolean};
