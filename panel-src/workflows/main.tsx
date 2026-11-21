import { mountExtensionPage, useEffect, useState, useStore, useTranslation } from "@fyso/panel";
import es from "./es.json";
import en from "./en.json";

type Workflow = { name: string; read: boolean; run: boolean; outputs: boolean };
type Report = { workflows: Workflow[]; failed: boolean };

function workflowsOf(capabilities: string[]): Workflow[] {
  const byName = new Map<string, Workflow>();
  for (const capability of capabilities) {
    const match = /^workflow:([a-z0-9][a-z0-9_.-]{0,127}):(read|run|read-outputs)$/.exec(capability);
    if (!match) continue;
    const [, name, operation] = match;
    const workflow = byName.get(name) ?? { name, read: false, run: false, outputs: false };
    if (operation === "read") workflow.read = true;
    if (operation === "run") workflow.run = true;
    if (operation === "read-outputs") workflow.outputs = true;
    byName.set(name, workflow);
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

function WorkflowCard({ workflow }: Readonly<{ workflow: Workflow }>) {
  const { t } = useTranslation();
  const { backend } = useStore();
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const [started, setStarted] = useState<string>();
  const [last, setLast] = useState<Awaited<ReturnType<typeof backend.lastRun>>>();
  const [outputs, setOutputs] = useState<Record<string, unknown>>();
  const runId = started ?? last?.id;
  const [parameters, setParameters] = useState("");
  const [invalid, setInvalid] = useState(false);

  async function submit() {
    if (!workflow.run || busy) return;
    let input: Record<string, string> | undefined;
    try {
      const raw: unknown = parameters.trim() ? JSON.parse(parameters) : {};
      if (!raw || typeof raw !== "object" || Array.isArray(raw) ||
          Object.values(raw).some(value => typeof value !== "string")) throw Error("parameters");
      input = raw as Record<string, string>;
    } catch {
      setInvalid(true);
      return;
    }
    setInvalid(false);
    setFailed(false);
    setOutputs(undefined);
    setBusy(true);
    try {
      setStarted(await backend.enqueue(workflow.name, input));
      setLast(undefined);
    } catch {
      setFailed(true);
    } finally {
      setBusy(false);
    }
  }

  async function refresh() {
    setFailed(false);
    try {
      const execution = started ? await backend.getRun(workflow.name, started) : await backend.lastRun(workflow.name);
      setLast(execution);
    } catch {
      setFailed(true);
    }
  }

  async function readOutputs() {
    if (!runId) return;
    setFailed(false);
    try {
      setOutputs(await backend.getOutputs(workflow.name, runId));
    } catch {
      setFailed(true);
    }
  }

  return (
    <article className="card action">
      <div className="action-head">
        <h2 className="grow">{workflow.name}</h2>
        {workflow.read && last && <span className="action-status">{last.statusLabel}</span>}
      </div>
      {workflow.run && (
        <form onSubmit={event => { event.preventDefault(); void submit(); }}>
          <label className="field">
            {t("parameters")}
            <textarea className="input" rows={2} placeholder='{"NAME":"value"}' value={parameters}
              onChange={event => setParameters(event.target.value)} />
          </label>
          {invalid && <p role="alert">{t("parametersInvalid")}</p>}
          <button className="btn btn-pri" type="submit" disabled={busy}>
            {t(busy ? "running" : "run")}
          </button>
        </form>
      )}
      {started && <p role="status">{t("queued")}</p>}
      {workflow.read && <button className="btn btn-soft" type="button" onClick={() => void refresh()}>{t("refresh")}</button>}
      {workflow.outputs && runId && <button className="btn btn-soft" type="button" onClick={() => void readOutputs()}>{t("result")}</button>}
      {failed && <p role="alert">{t("runError")}</p>}
      {workflow.outputs && outputs && (
        <section>
          <h3>{t("result")}</h3>
          <pre>{JSON.stringify(outputs, null, 2)}</pre>
        </section>
      )}
    </article>
  );
}

function Workflows() {
  const { t } = useTranslation();
  const [report, setReport] = useState<Report>();
  useEffect(() => {
    const controller = new AbortController();
    async function refresh() {
      try {
        const response = await fetch("/api/panel-access", { cache: "no-store", signal: controller.signal });
        if (response.status === 204) {
          setReport({ workflows: [], failed: false });
          return;
        }
        if (!response.ok) throw Error("policy");
        const data = await response.json();
        if (!Array.isArray(data?.capabilities) || data.capabilities.some((value: unknown) => typeof value !== "string")) throw Error("policy");
        if (!controller.signal.aborted) setReport({ workflows: workflowsOf(data.capabilities), failed: false });
      } catch {
        if (!controller.signal.aborted) setReport({ workflows: [], failed: true });
      }
    }
    void refresh();
    const interval = window.setInterval(() => void refresh(), 30_000);
    return () => { controller.abort(); window.clearInterval(interval); };
  }, []);

  return (
    <main className="workspace">
      <h1>{t("title")}</h1>
      {report?.failed ? <p role="alert">{t("unavailable")}</p> : report?.workflows.length === 0 ? <p>{t("empty")}</p> : null}
      {report?.workflows.map(workflow => <WorkflowCard key={workflow.name} workflow={workflow} />)}
    </main>
  );
}

void mountExtensionPage(Workflows, { es, en });
