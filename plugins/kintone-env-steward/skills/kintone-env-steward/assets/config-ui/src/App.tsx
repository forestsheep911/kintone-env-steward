import { useEffect, useMemo, useState } from "react"
import {
  AlertCircle,
  Check,
  ChevronRight,
  CircleGauge,
  Copy,
  Database,
  Eye,
  EyeOff,
  FileCheck2,
  KeyRound,
  Laptop,
  Plus,
  Save,
  Settings2,
  ShieldCheck,
  Trash2,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Field, Input, Select } from "@/components/ui/field"
import { cn } from "@/lib/utils"

type UiMode = "simple" | "advanced"
type Step = "project" | "environments" | "review"
type EnvironmentKind = "customer-source" | "experiment" | "customer-target"
type AccessMode = "read-only" | "read-write"
type CredentialMethod = "password" | "api-token" | "client-certificate-password"

interface Environment {
  id: string
  label: string
  kind: EnvironmentKind
  accessMode: AccessMode
  baseUrl: string
  requiredRole: string
  credentialRef: Record<string, string>
  appScope: string[]
}

interface StewardConfig {
  schemaVersion: string
  activeEnvironmentId: string
  engagement: {
    id: string
    customerAlias: string
    artifactRoot: string
  }
  workflow: {
    mode: string
    sourceEnvironmentId: string
    experimentEnvironmentIds: string[]
    targetEnvironmentId: string | null
  }
  environments: Environment[]
}

interface Meta {
  version: string
  workspace: string
  configPath: string
  credentialsPath: string
  uiMode: UiMode
  uiModeReason: string
  initialContextApplied: boolean
}

interface CredentialStatus {
  configured: boolean
  method: string
  fields: Record<string, boolean>
}

interface SecretChange {
  username?: string
  password?: string
  apiToken?: string
  pfxFilePath?: string
  pfxPassword?: string
  clear?: boolean
}

interface Validation {
  valid: boolean
  warnings: string[]
  errors: string[]
  summary?: string
}

interface AccessRequest {
  id: string
  environmentId: string
  environmentLabel: string
  currentAccessMode: AccessMode
  requestedAccessMode: AccessMode
  reason: string
  requestedAt: string
}

const kindLabels: Record<EnvironmentKind, string> = {
  "customer-source": "客户源环境",
  experiment: "实验环境",
  "customer-target": "客户实施环境",
}

const csrf =
  document.querySelector<HTMLMetaElement>('meta[name="steward-csrf"]')?.content ?? ""

async function request<T>(url: string, options: RequestInit = {}): Promise<T> {
  const response = await fetch(url, options)
  const body = await response.json()
  if (!response.ok) {
    const error = new Error(body.error || "请求失败") as Error & { body?: Validation }
    error.body = body
    throw error
  }
  return body
}

function slug(value: string) {
  return value
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 56)
}

function parseAppScopeExpression(value: string) {
  const expression = value.trim()
  if (expression === "*") return ["*"]
  if (!expression) throw new Error("App 范围不能为空")
  const ids = new Set<string>()
  for (const rawItem of expression.split(",")) {
    const item = rawItem.trim()
    const match = item.match(/^([1-9][0-9]*)(?:\s*-\s*([1-9][0-9]*))?$/)
    if (!match) throw new Error(`无效的 App ID 或区间：${item || "空项"}`)
    const start = BigInt(match[1])
    const end = BigInt(match[2] || match[1])
    if (start > 9223372036854775807n || end > 9223372036854775807n) {
      throw new Error(`App ID 超出 kintone 支持范围：${item}`)
    }
    if (end < start) throw new Error(`区间终点不能小于起点：${item}`)
    if (end - start + 1n > 10000n) throw new Error("单个区间最多展开 10000 个 App ID")
    for (let id = start; id <= end; id += 1n) {
      ids.add(id.toString())
      if (ids.size > 10000) throw new Error("App 范围最多包含 10000 个 App ID")
    }
  }
  return [...ids].sort((left, right) => {
    const a = BigInt(left)
    const b = BigInt(right)
    return a < b ? -1 : a > b ? 1 : 0
  })
}

function formatAppScope(ids: string[]) {
  if (ids.length === 1 && ids[0] === "*") return "*"
  const values = [...new Set(ids)]
    .filter((id) => /^[1-9][0-9]*$/.test(id))
    .map(BigInt)
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
  const parts: string[] = []
  for (let index = 0; index < values.length;) {
    const start = values[index]
    let end = start
    while (index + 1 < values.length && values[index + 1] === end + 1n) {
      index += 1
      end = values[index]
    }
    parts.push(start === end ? start.toString() : `${start}-${end}`)
    index += 1
  }
  return parts.join(",")
}

function credentialReference(id: string, method: CredentialMethod) {
  const prefix = id.replace(/[^a-z0-9]+/gi, "_").replace(/^_+|_+$/g, "").toUpperCase()
  if (method === "api-token") return { method, apiTokenEnv: `${prefix}_API_TOKEN` }
  const reference: Record<string, string> = {
    method,
    usernameEnv: `${prefix}_ADMIN_USERNAME`,
    passwordEnv: `${prefix}_ADMIN_PASSWORD`,
  }
  if (method === "client-certificate-password") {
    reference.pfxFilePathEnv = `${prefix}_PFX_PATH`
    reference.pfxPasswordEnv = `${prefix}_PFX_PASSWORD`
  }
  return reference
}

function defaultEnvironment(kind: EnvironmentKind, index: number): Environment {
  const id = kind === "experiment" ? `lab-${index}` : `${kind}-${index}`
  return {
    id,
    label: kind === "experiment" ? `实验环境 ${index}` : kindLabels[kind],
    kind,
    accessMode: "read-only",
    baseUrl: "https://example.cybozu.com",
    requiredRole: "system-administrator",
    credentialRef: credentialReference(id, "password"),
    appScope: ["*"],
  }
}

function prepareConfig(input: StewardConfig): StewardConfig {
  const config = structuredClone(input)
  config.environments = config.environments.map((environment) => {
    const next = structuredClone(environment) as Environment & Record<string, unknown>
    const method = (next.credentialRef.method || "password") as CredentialMethod
    next.credentialRef = credentialReference(next.id, method)
    delete next.allowedOperations
    delete next.approvals
    delete next.dataHandling
    return next
  })
  const source = config.environments.find((item) => item.kind === "customer-source")
  const experiments = config.environments.filter((item) => item.kind === "experiment")
  const target = config.environments.find((item) => item.kind === "customer-target")
  const cycle = experiments.length > 0 || Boolean(target)
  config.workflow = {
    mode: cycle ? "experiment-cycle" : "analysis-only",
    sourceEnvironmentId: source?.id ?? "",
    experimentEnvironmentIds: experiments.map((item) => item.id),
    targetEnvironmentId: cycle ? target?.id ?? "" : null,
  }
  if (!config.environments.some((item) => item.id === config.activeEnvironmentId)) {
    config.activeEnvironmentId = source?.id ?? config.environments[0]?.id ?? ""
  }
  return config
}

function ModeSwitch({ mode, onChange }: { mode: UiMode; onChange: (mode: UiMode) => void }) {
  return (
    <div className="inline-flex rounded-lg border border-border bg-muted/60 p-1" aria-label="界面模式">
      {(["simple", "advanced"] as UiMode[]).map((item) => (
        <button
          type="button"
          key={item}
          onClick={() => onChange(item)}
          className={cn(
            "rounded-md px-3 py-1.5 text-xs font-semibold transition",
            mode === item ? "bg-background text-foreground shadow-sm" : "text-muted-foreground",
          )}
        >
          {item === "simple" ? "简洁" : "完整"}
        </button>
      ))}
    </div>
  )
}

function EnvironmentEditor({
  environment,
  index,
  total,
  mode,
  status,
  secret,
  onChange,
  onSecret,
  onDuplicate,
  onRemove,
}: {
  environment: Environment
  index: number
  total: number
  mode: UiMode
  status?: CredentialStatus
  secret: SecretChange
  onChange: (next: Environment) => void
  onSecret: (next: SecretChange) => void
  onDuplicate: () => void
  onRemove: () => void
}) {
  const method = (environment.credentialRef.method || "password") as CredentialMethod
  const [appScopeText, setAppScopeText] = useState(() => formatAppScope(environment.appScope))
  const [appScopeError, setAppScopeError] = useState("")
  const update = <K extends keyof Environment>(key: K, value: Environment[K]) =>
    onChange({ ...environment, [key]: value })
  const updateMethod = (nextMethod: CredentialMethod) =>
    update("credentialRef", credentialReference(environment.id, nextMethod))
  const pending = Object.entries(secret).some(([key, value]) => key !== "clear" && Boolean(value))
  const credentialLabel = secret.clear
    ? "保存后清除"
    : pending
      ? "有待保存的凭据"
      : status?.configured
        ? "已保存在本机"
        : "尚未配置"

  return (
    <Card className="overflow-hidden">
      <CardHeader className="border-b border-border bg-muted/35 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-3">
          <span className="grid size-9 place-items-center rounded-xl bg-foreground text-xs font-bold text-background">
            {String(index + 1).padStart(2, "0")}
          </span>
          <div>
            <CardTitle>{environment.label || "未命名环境"}</CardTitle>
            <CardDescription>{kindLabels[environment.kind]} · {environment.accessMode === "read-only" ? "只读" : "读写"}</CardDescription>
          </div>
        </div>
        <div className="flex gap-1">
          <Button type="button" variant="ghost" size="sm" onClick={onDuplicate}><Copy className="size-3.5" />复制</Button>
          <Button type="button" variant="destructive" size="sm" onClick={onRemove} disabled={total === 1}><Trash2 className="size-3.5" />删除</Button>
        </div>
      </CardHeader>
      <CardContent className="grid gap-6 pt-5">
        <div className="grid gap-4 md:grid-cols-2">
          <Field label="环境别名">
            <Input value={environment.label} onChange={(event) => update("label", event.target.value)} placeholder="例：客户生产环境" />
          </Field>
          <Field label="kintone 地址">
            <Input type="url" value={environment.baseUrl} onChange={(event) => update("baseUrl", event.target.value)} placeholder="https://example.cybozu.com" />
          </Field>
          <Field label="访问模式" hint="聊天中的操作超出该边界时，会再次弹窗确认修改">
            <Select
              value={environment.accessMode}
              onChange={(event) => update("accessMode", event.target.value as AccessMode)}
            >
              <option value="read-only">只读</option>
              <option value="read-write">读写</option>
            </Select>
          </Field>
          <Field label="App 范围" hint="支持 1,3-5,7-12；区间包含首尾，* 表示全部 App">
            <Input
              value={appScopeText}
              aria-invalid={Boolean(appScopeError)}
              onChange={(event) => {
                const expression = event.target.value
                setAppScopeText(expression)
                try {
                  update("appScope", parseAppScopeExpression(expression))
                  setAppScopeError("")
                } catch (cause) {
                  setAppScopeError((cause as Error).message)
                }
              }}
              placeholder="1,3-5,7-12 或 *"
            />
            {appScopeError && <span className="text-xs font-normal text-destructive">{appScopeError}</span>}
          </Field>
        </div>

        {mode === "advanced" && (
          <div className="grid gap-4 rounded-xl border border-border bg-muted/25 p-4 md:grid-cols-3">
            <Field label="环境 ID">
              <Input value={environment.id} onChange={(event) => update("id", slug(event.target.value))} />
            </Field>
            <Field label="环境类型">
              <Select
                value={environment.kind}
                onChange={(event) => {
                  const kind = event.target.value as EnvironmentKind
                  onChange({ ...environment, kind })
                }}
              >
                <option value="customer-source">客户源环境</option>
                <option value="experiment">实验环境</option>
                <option value="customer-target">客户实施环境</option>
              </Select>
            </Field>
            <Field label="治理账号角色">
              <Select value={environment.requiredRole} onChange={(event) => update("requiredRole", event.target.value)}>
                <option value="system-administrator">系统管理员（推荐）</option>
                <option value="app-administrator">App 管理员</option>
                <option value="read-only">只读账号</option>
              </Select>
            </Field>
          </div>
        )}

        <div className="grid gap-4 rounded-xl border border-teal-200 bg-teal-50/60 p-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <KeyRound className="size-4 text-teal-700" />
              <strong className="text-sm">登录凭据</strong>
              <span className={cn("rounded-full px-2 py-0.5 text-xs", status?.configured && !secret.clear ? "bg-emerald-100 text-emerald-800" : "bg-amber-100 text-amber-800")}>{credentialLabel}</span>
            </div>
            <span className="text-xs text-teal-800">只写入本机，不会发送到外部</span>
          </div>
          <div className="grid gap-4 md:grid-cols-2">
            <Field label="登录方式">
              <Select value={method} onChange={(event) => updateMethod(event.target.value as CredentialMethod)}>
                <option value="password">用户名 + 密码</option>
                <option value="api-token">API Token</option>
                {mode === "advanced" && <option value="client-certificate-password">用户名 + 密码 + 客户端证书</option>}
              </Select>
            </Field>
            {method !== "api-token" && (
              <Field label="用户名">
                <Input autoComplete="username" value={secret.username ?? ""} onChange={(event) => onSecret({ ...secret, clear: false, username: event.target.value })} placeholder={status?.fields?.username ? "已保存；留空则保留" : "系统管理员用户名"} />
              </Field>
            )}
            {method !== "api-token" && (
              <Field label="密码">
                <Input type="password" autoComplete="new-password" value={secret.password ?? ""} onChange={(event) => onSecret({ ...secret, clear: false, password: event.target.value })} placeholder={status?.fields?.password ? "已保存；留空则保留" : "请输入密码"} />
              </Field>
            )}
            {method === "api-token" && (
              <Field label="API Token">
                <Input type="password" value={secret.apiToken ?? ""} onChange={(event) => onSecret({ ...secret, clear: false, apiToken: event.target.value })} placeholder={status?.fields?.apiToken ? "已保存；留空则保留" : "请输入 API Token"} />
              </Field>
            )}
            {method === "client-certificate-password" && (
              <>
                <Field label="PFX 文件路径">
                  <Input value={secret.pfxFilePath ?? ""} onChange={(event) => onSecret({ ...secret, clear: false, pfxFilePath: event.target.value })} placeholder="C:\secure\client.pfx" />
                </Field>
                <Field label="PFX 密码">
                  <Input type="password" value={secret.pfxPassword ?? ""} onChange={(event) => onSecret({ ...secret, clear: false, pfxPassword: event.target.value })} />
                </Field>
              </>
            )}
          </div>
          {status?.configured && (
            <Button type="button" variant="destructive" size="sm" className="w-fit" onClick={() => onSecret({ clear: true })}>
              清除本机凭据
            </Button>
          )}
        </div>
      </CardContent>
    </Card>
  )
}

export default function App() {
  const [config, setConfig] = useState<StewardConfig | null>(null)
  const [meta, setMeta] = useState<Meta | null>(null)
  const [mode, setMode] = useState<UiMode>("simple")
  const [step, setStep] = useState<Step>("environments")
  const [selectedEnvironmentIndex, setSelectedEnvironmentIndex] = useState(0)
  const [statuses, setStatuses] = useState<Record<string, CredentialStatus>>({})
  const [secrets, setSecrets] = useState<Record<string, SecretChange>>({})
  const [validation, setValidation] = useState<Validation | null>(null)
  const [saving, setSaving] = useState(false)
  const [notice, setNotice] = useState("")
  const [error, setError] = useState("")
  const [accessRequest, setAccessRequest] = useState<AccessRequest | null>(null)
  const [resolvingRequest, setResolvingRequest] = useState(false)

  useEffect(() => {
    Promise.all([
      request<{ config: StewardConfig; exists: boolean }>("/api/config"),
      request<Meta>("/api/meta"),
      request<{ environments: Record<string, CredentialStatus> }>("/api/credentials/status"),
    ])
      .then(([configResponse, metaResponse, credentialResponse]) => {
        const normalized = prepareConfig(configResponse.config)
        setConfig(normalized)
        setMeta(metaResponse)
        setMode(metaResponse.uiMode)
        setStep(metaResponse.uiMode === "simple" ? "environments" : "project")
        setStatuses(credentialResponse.environments)
        if (!configResponse.exists) setNotice(metaResponse.initialContextApplied ? "已带入聊天中确认的信息，请核对后保存。" : "这是尚未保存的起始配置。")
      })
      .catch((cause: Error) => setError(cause.message))
  }, [])

  useEffect(() => {
    let active = true
    async function pollAccessRequest() {
      try {
        const response = await request<{ request: AccessRequest | null }>("/api/access-request")
        if (active) setAccessRequest(response.request)
      } catch {
        // The main startup error surface handles unavailable local services.
      }
    }
    void pollAccessRequest()
    const timer = window.setInterval(pollAccessRequest, 1200)
    return () => {
      active = false
      window.clearInterval(timer)
    }
  }, [])

  const prepared = useMemo(() => (config ? prepareConfig(config) : null), [config])
  const metrics = useMemo(() => {
    const environments = prepared?.environments ?? []
    return {
      total: environments.length,
      writes: environments.filter((item) => item.accessMode === "read-write").length,
    }
  }, [prepared])

  function dirty(next: StewardConfig) {
    setConfig(next)
    setValidation(null)
  }

  function updateEnvironment(index: number, environment: Environment) {
    if (!config) return
    const environments = [...config.environments]
    environments[index] = environment
    dirty({ ...config, environments })
  }

  function duplicateEnvironment(index: number) {
    if (!config) return
    const copy = structuredClone(config.environments[index])
    copy.id = `${copy.id}-copy`
    copy.label = `${copy.label}（副本）`
    copy.credentialRef = credentialReference(copy.id, (copy.credentialRef.method || "password") as CredentialMethod)
    const environments = [...config.environments]
    environments.splice(index + 1, 0, copy)
    dirty({ ...config, environments })
    setSelectedEnvironmentIndex(index + 1)
  }

  function removeEnvironment(index: number) {
    if (!config || config.environments.length === 1) return
    dirty({ ...config, environments: config.environments.filter((_, itemIndex) => itemIndex !== index) })
    setSelectedEnvironmentIndex(Math.max(0, Math.min(index, config.environments.length - 2)))
  }

  async function validateConfig() {
    if (!prepared) return false
    setSaving(true)
    try {
      const result = await request<Validation>("/api/validate", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Steward-CSRF": csrf },
        body: JSON.stringify(prepared),
      })
      setValidation(result)
      return result.valid
    } catch (cause) {
      const issue = cause as Error & { body?: Validation }
      setValidation(issue.body ?? { valid: false, warnings: [], errors: [issue.message] })
      return false
    } finally {
      setSaving(false)
    }
  }

  async function saveConfig() {
    if (!prepared) return
    setSaving(true)
    try {
      const checked = validation?.valid || (await validateConfig())
      if (!checked) return
      const credentialChanges = Object.fromEntries(
        Object.entries(secrets).filter(([, value]) =>
          value.clear || Object.entries(value).some(([key, field]) => key !== "clear" && field !== ""),
        ),
      )
      const result = await request<Validation & { credentials: Record<string, CredentialStatus>; configPath: string }>("/api/config", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Steward-CSRF": csrf },
        body: JSON.stringify({ config: prepared, credentialChanges }),
      })
      setConfig(prepared)
      setStatuses(result.credentials)
      setSecrets({})
      setValidation(result)
      setNotice(`已保存到本机：${result.configPath}`)
    } catch (cause) {
      const issue = cause as Error & { body?: Validation }
      setValidation(issue.body ?? { valid: false, warnings: [], errors: [issue.message] })
    } finally {
      setSaving(false)
    }
  }

  async function resolvePermissionRequest(decision: "approve" | "deny") {
    if (!accessRequest) return
    setResolvingRequest(true)
    try {
      const result = await request<{ approved: boolean; accessMode?: AccessMode; configPath?: string }>(
        "/api/access-request/resolve",
        {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-Steward-CSRF": csrf },
          body: JSON.stringify({ requestId: accessRequest.id, decision }),
        },
      )
      if (result.approved) {
        const refreshed = await request<{ config: StewardConfig }>("/api/config")
        setConfig(prepareConfig(refreshed.config))
        setValidation(null)
        setNotice(`已将“${accessRequest.environmentLabel}”改为${result.accessMode === "read-write" ? "读写" : "只读"}，并写回本机配置。`)
      } else {
        setNotice(`已保留“${accessRequest.environmentLabel}”当前的访问模式。`)
      }
      setAccessRequest(null)
    } catch (cause) {
      setNotice(`权限修改失败：${(cause as Error).message}`)
    } finally {
      setResolvingRequest(false)
    }
  }

  if (error) {
    return <main className="grid min-h-screen place-items-center p-6"><Card className="max-w-lg"><CardHeader><CardTitle>配置台无法启动</CardTitle><CardDescription>{error}</CardDescription></CardHeader></Card></main>
  }
  if (!config || !meta) {
    return <main className="grid min-h-screen place-items-center"><div className="flex items-center gap-3 text-sm text-muted-foreground"><CircleGauge className="size-5 animate-spin" />正在读取本机配置…</div></main>
  }

  const steps: { id: Step; label: string; icon: typeof Settings2 }[] =
    mode === "simple"
      ? [{ id: "environments", label: "环境", icon: ShieldCheck }, { id: "review", label: "检查", icon: FileCheck2 }]
      : [{ id: "project", label: "项目", icon: Settings2 }, { id: "environments", label: "环境", icon: ShieldCheck }, { id: "review", label: "检查", icon: FileCheck2 }]

  return (
    <div className="min-h-screen">
      <header className="sticky top-0 z-20 border-b border-border bg-background/90 backdrop-blur-xl">
        <div className="mx-auto flex h-16 max-w-6xl items-center justify-between gap-4 px-4 sm:px-6">
          <div className="flex min-w-0 items-center gap-3">
            <span className="grid size-9 shrink-0 place-items-center rounded-xl bg-primary text-xs font-black text-primary-foreground">ks</span>
            <div className="min-w-0">
              <strong className="block truncate text-sm">kintone-env-Steward</strong>
              <span className="block text-xs text-muted-foreground">v{meta.version} · 仅在本机运行</span>
            </div>
          </div>
          <ModeSwitch mode={mode} onChange={(next) => { setMode(next); if (next === "simple" && step === "project") setStep("environments") }} />
        </div>
      </header>

      <main className="mx-auto grid max-w-6xl gap-6 px-4 py-6 sm:px-6 lg:grid-cols-[210px_1fr]">
        <aside className="space-y-4 lg:sticky lg:top-22 lg:self-start">
          <nav className="flex gap-2 overflow-x-auto lg:grid" aria-label="配置步骤">
            {steps.map((item, index) => {
              const Icon = item.icon
              return (
                <button
                  type="button"
                  key={item.id}
                  onClick={() => setStep(item.id)}
                  className={cn(
                    "flex min-w-fit items-center gap-3 rounded-xl px-3 py-2.5 text-left text-sm font-semibold transition",
                    step === item.id ? "bg-foreground text-background" : "text-muted-foreground hover:bg-muted hover:text-foreground",
                  )}
                >
                  <Icon className="size-4" />
                  <span>{String(index + 1).padStart(2, "0")} {item.label}</span>
                </button>
              )
            })}
          </nav>
          <div className="hidden rounded-xl border border-border bg-card p-3 text-xs text-muted-foreground lg:block">
            <div className="mb-2 flex items-center gap-2 font-semibold text-foreground"><Laptop className="size-3.5" />当前工作目录</div>
            <p className="break-all font-mono leading-relaxed">{meta.workspace}</p>
          </div>
        </aside>

        <section className="min-w-0 space-y-5">
          {notice && (
            <div className="flex items-start justify-between gap-3 rounded-xl border border-teal-200 bg-teal-50 px-4 py-3 text-sm text-teal-900">
              <span>{notice}</span>
              <button type="button" onClick={() => setNotice("")} aria-label="关闭提示">×</button>
            </div>
          )}

          {step === "project" && (
            <>
              <div>
                <p className="section-kicker">PROJECT</p>
                <h1>项目基本信息</h1>
                <p className="section-copy">这些信息只用于组织本地治理产物，不要求填写客户真实名称。</p>
              </div>
              <Card>
                <CardContent className="grid gap-5 pt-5 md:grid-cols-2">
                  <Field label="项目 ID" hint="只使用小写字母、数字和连字符">
                    <Input value={config.engagement.id} onChange={(event) => dirty({ ...config, engagement: { ...config.engagement, id: slug(event.target.value) } })} />
                  </Field>
                  <Field label="客户别名">
                    <Input value={config.engagement.customerAlias} onChange={(event) => dirty({ ...config, engagement: { ...config.engagement, customerAlias: event.target.value } })} placeholder="例：制造业客户 A" />
                  </Field>
                  <Field label="治理产物目录" className="md:col-span-2">
                    <Input value={config.engagement.artifactRoot} onChange={(event) => dirty({ ...config, engagement: { ...config.engagement, artifactRoot: event.target.value } })} />
                  </Field>
                </CardContent>
              </Card>
              <div className="flex justify-end"><Button type="button" onClick={() => setStep("environments")}>继续配置环境<ChevronRight className="size-4" /></Button></div>
            </>
          )}

          {step === "environments" && (
            <>
              <div className="flex flex-wrap items-end justify-between gap-4">
                <div>
                  <p className="section-kicker">ENVIRONMENTS</p>
                  <h1>{mode === "simple" ? "连接一个 kintone 环境" : "环境与权限边界"}</h1>
                  <p className="section-copy">
                    {mode === "simple"
                      ? "填入地址和登录信息即可；其余使用安全默认值。"
                      : "为每个环境定义身份、只读或读写边界，以及数据处理要求。"}
                  </p>
                </div>
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => {
                    const nextIndex = config.environments.filter((item) => item.kind === "experiment").length + 1
                    dirty({ ...config, environments: [...config.environments, defaultEnvironment("experiment", nextIndex)] })
                    setSelectedEnvironmentIndex(config.environments.length)
                  }}
                >
                  <Plus className="size-4" />添加环境
                </Button>
              </div>

              {mode === "simple" && (
                <Card className="border-dashed">
                  <CardContent className="grid gap-4 pt-5 md:grid-cols-2">
                    <Field label="客户别名" hint="聊天中已确认时会自动带入">
                      <Input value={config.engagement.customerAlias} onChange={(event) => dirty({ ...config, engagement: { ...config.engagement, customerAlias: event.target.value } })} placeholder="例：客户 A" />
                    </Field>
                    <div className="flex items-end">
                      <p className="pb-2 text-xs text-muted-foreground">{meta.uiModeReason}</p>
                    </div>
                  </CardContent>
                </Card>
              )}

              <Card>
                <CardContent className="grid gap-3 pt-5 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-end">
                  <Field label={`正在配置（共 ${config.environments.length} 个环境）`}>
                    <Select
                      value={selectedEnvironmentIndex}
                      onChange={(event) => setSelectedEnvironmentIndex(Number(event.target.value))}
                    >
                      {config.environments.map((environment, index) => (
                        <option key={`${environment.id}-${index}`} value={index}>
                          {String(index + 1).padStart(2, "0")} · {environment.label || "未命名环境"} · {environment.accessMode === "read-write" ? "读写" : "只读"}
                        </option>
                      ))}
                    </Select>
                  </Field>
                  <p className="pb-2 text-xs text-muted-foreground">切换环境不会丢失当前输入</p>
                </CardContent>
              </Card>

              {config.environments[selectedEnvironmentIndex] && (
                <EnvironmentEditor
                  key={selectedEnvironmentIndex}
                  environment={config.environments[selectedEnvironmentIndex]}
                  index={selectedEnvironmentIndex}
                  total={config.environments.length}
                  mode={mode}
                  status={statuses[config.environments[selectedEnvironmentIndex].id]}
                  secret={secrets[config.environments[selectedEnvironmentIndex].id] ?? {}}
                  onChange={(next) => updateEnvironment(selectedEnvironmentIndex, next)}
                  onSecret={(next) =>
                    setSecrets((current) => ({
                      ...current,
                      [config.environments[selectedEnvironmentIndex].id]: next,
                    }))
                  }
                  onDuplicate={() => duplicateEnvironment(selectedEnvironmentIndex)}
                  onRemove={() => removeEnvironment(selectedEnvironmentIndex)}
                />
              )}
              <div className="flex justify-end"><Button type="button" onClick={() => setStep("review")}>检查并保存<ChevronRight className="size-4" /></Button></div>
            </>
          )}

          {step === "review" && (
            <>
              <div>
                <p className="section-kicker">REVIEW</p>
                <h1>保存前检查边界</h1>
                <p className="section-copy">确认哪些环境能够写入，哪些数据可以留在本机。</p>
              </div>
              <div className="grid gap-4 sm:grid-cols-2">
                <Card><CardContent className="pt-5"><Database className="mb-4 size-5 text-muted-foreground" /><strong className="block text-3xl">{metrics.total}</strong><span className="text-sm text-muted-foreground">已配置环境</span></CardContent></Card>
                <Card className={cn(metrics.writes > 0 && "border-amber-300")}><CardContent className="pt-5"><EyeOff className="mb-4 size-5 text-muted-foreground" /><strong className="block text-3xl">{metrics.writes}</strong><span className="text-sm text-muted-foreground">允许写入</span></CardContent></Card>
              </div>
              <Card className={cn(validation?.valid === true && "border-emerald-300", validation?.valid === false && "border-destructive/40")}>
                <CardContent className="flex gap-4 pt-5">
                  <span className={cn("grid size-10 shrink-0 place-items-center rounded-full bg-muted", validation?.valid === true && "bg-emerald-100 text-emerald-700", validation?.valid === false && "bg-red-100 text-destructive")}>
                    {validation?.valid === true ? <Check className="size-5" /> : validation?.valid === false ? <AlertCircle className="size-5" /> : <Eye className="size-5" />}
                  </span>
                  <div>
                    <strong>{validation?.valid === true ? "边界检查通过" : validation?.valid === false ? "配置需要调整" : "尚未检查"}</strong>
                    {!validation && <p className="mt-1 text-sm text-muted-foreground">运行检查后才可以保存。</p>}
                    {validation && validation.errors.length > 0 && <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-destructive">{validation.errors.map((item) => <li key={item}>{item}</li>)}</ul>}
                    {validation && validation.warnings.length > 0 && <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-amber-700">{validation.warnings.map((item) => <li key={item}>{item}</li>)}</ul>}
                  </div>
                </CardContent>
              </Card>
              <div className="flex flex-wrap justify-end gap-3">
                <Button type="button" variant="outline" onClick={validateConfig} disabled={saving}><FileCheck2 className="size-4" />检查配置</Button>
                <Button type="button" onClick={saveConfig} disabled={saving}><Save className="size-4" />{saving ? "处理中…" : "保存到本机"}</Button>
              </div>
            </>
          )}
        </section>
      </main>

      <Dialog open={Boolean(accessRequest)}>
        <DialogContent showClose={false}>
          <DialogHeader>
            <div className="mb-1 flex size-11 items-center justify-center rounded-xl bg-amber-100 text-amber-800">
              <ShieldCheck className="size-5" />
            </div>
            <DialogTitle>修改“{accessRequest?.environmentLabel}”的访问模式？</DialogTitle>
            <DialogDescription>
              聊天中准备进行的操作超出了当前权限。请在这里确认是否调整本机环境配置。
            </DialogDescription>
          </DialogHeader>
          <div className="rounded-xl border border-border bg-muted/45 p-4">
            <div className="flex items-center gap-3 text-sm font-semibold">
              <span className="rounded-md bg-background px-2.5 py-1.5 shadow-sm">
                {accessRequest?.currentAccessMode === "read-write" ? "读写" : "只读"}
              </span>
              <ChevronRight className="size-4 text-muted-foreground" />
              <span className="rounded-md bg-amber-100 px-2.5 py-1.5 text-amber-900">
                {accessRequest?.requestedAccessMode === "read-write" ? "读写" : "只读"}
              </span>
            </div>
            <p className="mt-3 text-sm text-muted-foreground">{accessRequest?.reason}</p>
          </div>
          <p className="text-xs leading-relaxed text-muted-foreground">
            确认只会修改 <code>environments.yaml</code> 中该环境的访问模式，不会立即执行聊天中提到的操作。
          </p>
          <DialogFooter>
            <Button type="button" variant="outline" disabled={resolvingRequest} onClick={() => resolvePermissionRequest("deny")}>
              保持当前设置
            </Button>
            <Button type="button" disabled={resolvingRequest} onClick={() => resolvePermissionRequest("approve")}>
              {resolvingRequest ? "正在写回…" : `确认改为${accessRequest?.requestedAccessMode === "read-write" ? "读写" : "只读"}`}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
