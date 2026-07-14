#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::fs;
use std::fs::OpenOptions;
use std::io::Write;
use std::net::{TcpListener, TcpStream};
#[cfg(windows)]
use std::os::windows::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::{Mutex, OnceLock};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder, WindowEvent};

const SINGLE_INSTANCE_ADDR: &str = "127.0.0.1:48617";
const ANIMATION_PREVIEW_INSTANCE_ADDR: &str = "127.0.0.1:48618";

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct FirstRunPayload {
    provider: serde_json::Value,
    interview: serde_json::Value,
    profile: serde_json::Value,
    cluster_config: serde_json::Value,
    agents: Vec<AgentFile>,
}

#[derive(Deserialize)]
struct AgentFile {
    path: String,
    contents: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProviderPayload {
    provider_name: String,
    base_url: String,
    model: String,
    api_key: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ProviderConnectionResult {
    ok: bool,
    message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    openclaw_manifest_path: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct DownloadToDesktopPayload {
    url: String,
    file_name: String,
    authorization: Option<String>,
    expected_size_bytes: Option<u64>,
    expected_checksum_sha256: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct DownloadToDesktopResult {
    path: String,
    bytes: u64,
    checksum_sha256: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct AgentModelConfigPayload {
    agent_id: String,
    provider_name: String,
    base_url: String,
    model: String,
    api_key: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SuggestionPayload {
    provider: ProviderPayload,
    industry: String,
    role: String,
    daily_work: String,
    language: String,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct InterviewSuggestions {
    role_examples: Vec<String>,
    work_options: Vec<String>,
    quality_examples: Vec<String>,
}

fn safe_join(root: &Path, relative: &str) -> Result<PathBuf, String> {
    let normalized = relative.replace('\\', "/");
    if normalized.starts_with('/') || normalized.contains("..") {
        return Err(format!("Unsafe relative path: {relative}"));
    }
    Ok(root.join(normalized))
}

fn chat_completions_url(base_url: &str) -> Result<String, String> {
    let trimmed = base_url.trim().trim_end_matches('/');
    if trimmed.is_empty() || !(trimmed.starts_with("https://") || trimmed.starts_with("http://")) {
        return Err("provider_endpoint".to_string());
    }
    if trimmed.ends_with("/chat/completions") {
        Ok(trimmed.to_string())
    } else {
        Ok(format!("{trimmed}/chat/completions"))
    }
}

fn clean_items(items: Vec<String>, fallback: &[&str], limit: usize) -> Vec<String> {
    let mut output: Vec<String> = Vec::new();
    for item in items.into_iter().chain(fallback.iter().map(|item| item.to_string())) {
        let cleaned = item
            .trim()
            .trim_matches(|value: char| value == '"' || value == '\'' || value == '。' || value == '.' || value == '…')
            .to_string();
        if cleaned.is_empty() || cleaned.chars().count() > 28 || output.iter().any(|existing| existing == &cleaned) {
            continue;
        }
        output.push(cleaned);
        if output.len() >= limit {
            break;
        }
    }
    output
}

async fn call_chat_completion(
    provider: &ProviderPayload,
    messages: Vec<serde_json::Value>,
    max_tokens: u32,
) -> Result<String, String> {
    if provider.model.trim().is_empty() || provider.api_key.trim().is_empty() {
        return Err("provider_missing".to_string());
    }
    let url = chat_completions_url(&provider.base_url)?;
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(45))
        .build()
        .map_err(|_| "provider_client".to_string())?;
    let mut body = serde_json::json!({
        "model": provider.model.trim(),
        "messages": messages,
        "max_tokens": max_tokens,
        "stream": false
    });
    if provider.base_url.contains("deepseek.com") {
        body["thinking"] = serde_json::json!({ "type": "disabled" });
    }
    let response = client
        .post(url)
        .bearer_auth(provider.api_key.trim())
        .json(&body)
        .send()
        .await
        .map_err(|_| "provider_network".to_string())?;
    let status = response.status();
    let body = response.text().await.unwrap_or_default();
    if !status.is_success() {
        return Err(format!("provider_status:{}", status.as_u16()));
    }
    let parsed: serde_json::Value = serde_json::from_str(&body)
        .map_err(|_| "provider_response".to_string())?;
    let content = parsed
        .get("choices")
        .and_then(|choices| choices.get(0))
        .and_then(|choice| choice.get("message"))
        .and_then(|message| message.get("content"))
        .and_then(|content| content.as_str())
        .unwrap_or("")
        .trim()
        .to_string();
    if content.is_empty() {
        return Err("provider_empty".to_string());
    }
    Ok(content)
}

fn parse_suggestions(content: &str) -> Result<InterviewSuggestions, String> {
    let start = content.find('{').ok_or_else(|| "provider_json".to_string())?;
    let end = content.rfind('}').ok_or_else(|| "provider_json".to_string())?;
    let json_slice = &content[start..=end];
    let parsed: InterviewSuggestions = serde_json::from_str(json_slice)
        .map_err(|_| "provider_json".to_string())?;
    Ok(InterviewSuggestions {
        role_examples: clean_items(parsed.role_examples, &["业务负责人", "一线执行人员", "技术/运营人员"], 4),
        work_options: clean_items(parsed.work_options, &["资料整理", "方案执行", "问题跟进", "交付复盘"], 4),
        quality_examples: clean_items(parsed.quality_examples, &["准确可追溯", "能直接交付", "符合实际场景", "便于复盘"], 4),
    })
}

fn timestamp_string() -> String {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs().to_string())
        .unwrap_or_else(|_| "0".to_string())
}

fn first_run_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let app_data = app.path().app_data_dir().map_err(|error| error.to_string())?;
    Ok(app_data.join("desktop-first-run"))
}

fn provider_api_key_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(first_run_dir(app)?.join("provider-api-key.txt"))
}

fn safe_storage_name(input: &str) -> String {
    let mut output = String::new();
    for value in input.trim().chars() {
        if value.is_ascii_alphanumeric() || value == '-' || value == '_' || value == '.' {
            output.push(value);
        } else {
            output.push('_');
        }
    }
    if output.is_empty() {
        "agent".to_string()
    } else {
        output.chars().take(96).collect()
    }
}

fn safe_desktop_file_name(input: &str) -> String {
    let mut output = String::new();
    for value in input.trim().chars() {
        if value.is_control() || matches!(value, '\\' | '/' | ':' | '*' | '?' | '"' | '<' | '>' | '|') {
            output.push('_');
        } else {
            output.push(value);
        }
    }
    let mut cleaned = output.trim().trim_matches('.').to_string();
    if cleaned.is_empty() {
        cleaned = "honeycomb-artifact".to_string();
    }
    let parsed = Path::new(&cleaned);
    let stem = parsed
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or("honeycomb-artifact");
    let upper_stem = stem.to_ascii_uppercase();
    if matches!(upper_stem.as_str(), "CON" | "PRN" | "AUX" | "NUL")
        || (upper_stem.starts_with("COM") || upper_stem.starts_with("LPT"))
            && upper_stem
                .get(3..)
                .and_then(|value| value.parse::<u8>().ok())
                .is_some_and(|value| (1..=9).contains(&value))
    {
        cleaned.insert(0, '_');
    }
    if cleaned.chars().count() <= 120 {
        return cleaned;
    }

    let parsed = Path::new(&cleaned);
    let extension = parsed
        .extension()
        .and_then(|value| value.to_str())
        .map(|value| format!(".{value}"))
        .unwrap_or_default();
    let stem = parsed
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or("honeycomb-artifact");
    let stem_limit = 120_usize.saturating_sub(extension.chars().count()).max(1);
    format!("{}{}", stem.chars().take(stem_limit).collect::<String>(), extension)
}

fn unique_desktop_file_path(desktop_dir: &Path, file_name: &str) -> PathBuf {
    let safe_name = safe_desktop_file_name(file_name);
    let path = desktop_dir.join(&safe_name);
    if !path.exists() {
        return path;
    }

    let parsed = Path::new(&safe_name);
    let stem = parsed
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or("honeycomb-artifact");
    let extension = parsed
        .extension()
        .and_then(|value| value.to_str())
        .map(|value| format!(".{value}"))
        .unwrap_or_default();

    for index in 2..1000 {
        let candidate = desktop_dir.join(format!("{stem}-{index}{extension}"));
        if !candidate.exists() {
            return candidate;
        }
    }

    desktop_dir.join(format!("{stem}-{}{}", timestamp_string(), extension))
}

fn cleanup_stale_delivery_parts(directory: &Path, target_name: &str) {
    let prefix = format!(".{target_name}.");
    let Ok(entries) = fs::read_dir(directory) else {
        return;
    };
    for entry in entries.flatten() {
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if name.starts_with(&prefix) && name.ends_with(".part") {
            let _ = fs::remove_file(entry.path());
        }
    }
}

fn agent_api_key_path(app: &AppHandle, agent_id: &str) -> Result<PathBuf, String> {
    Ok(first_run_dir(app)?
        .join("agent-api-keys")
        .join(format!("{}.key", safe_storage_name(agent_id))))
}

fn run_dpapi(action: &str, input: &str) -> Result<String, String> {
    let script = match action {
        "protect" => "$ErrorActionPreference='Stop';Add-Type -AssemblyName System.Security;$plain=[Console]::In.ReadToEnd();$bytes=[Text.Encoding]::UTF8.GetBytes($plain);$protected=[Security.Cryptography.ProtectedData]::Protect($bytes,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser);[Console]::Out.Write([Convert]::ToBase64String($protected))",
        "unprotect" => "$ErrorActionPreference='Stop';Add-Type -AssemblyName System.Security;$inputText=[Console]::In.ReadToEnd().Trim();$bytes=[Convert]::FromBase64String($inputText);$plain=[Security.Cryptography.ProtectedData]::Unprotect($bytes,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser);[Console]::Out.Write([Text.Encoding]::UTF8.GetString($plain))",
        _ => return Err("unsupported_dpapi_action".to_string()),
    };

    let mut command = Command::new("powershell");
    command
        .args([
            "-NoProfile",
            "-NonInteractive",
            "-ExecutionPolicy",
            "Bypass",
            "-Command",
            script,
        ])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    // Without CREATE_NO_WINDOW every DPAPI call flashes a console window over
    // the GUI app, because a windows-subsystem process has no console for the
    // child to inherit.
    #[cfg(windows)]
    command.creation_flags(0x0800_0000);

    let mut child = command.spawn().map_err(|error| error.to_string())?;

    if let Some(stdin) = child.stdin.as_mut() {
        stdin
            .write_all(input.as_bytes())
            .map_err(|error| error.to_string())?;
    }

    let output = child.wait_with_output().map_err(|error| error.to_string())?;
    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
    }

    Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
}

const DPAPI_CACHE_TTL: Duration = Duration::from_secs(300);

fn dpapi_unprotect_cache() -> &'static Mutex<HashMap<String, (String, Instant)>> {
    static CACHE: OnceLock<Mutex<HashMap<String, (String, Instant)>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

fn dpapi_cache_insert(ciphertext: &str, plaintext: &str) {
    if let Ok(mut cache) = dpapi_unprotect_cache().lock() {
        cache.retain(|_, (_, cached_at)| cached_at.elapsed() < DPAPI_CACHE_TTL);
        cache.insert(
            ciphertext.to_string(),
            (plaintext.to_string(), Instant::now()),
        );
    }
}

fn dpapi_unprotect_cached(ciphertext: &str) -> Result<String, String> {
    if let Ok(cache) = dpapi_unprotect_cache().lock() {
        if let Some((plaintext, cached_at)) = cache.get(ciphertext) {
            if cached_at.elapsed() < DPAPI_CACHE_TTL {
                return Ok(plaintext.clone());
            }
        }
    }
    let plaintext = run_dpapi("unprotect", ciphertext)?;
    dpapi_cache_insert(ciphertext, &plaintext);
    Ok(plaintext)
}

fn keychain_service() -> &'static str {
    "io.agentopenclaw.desktop.honeycomb-secrets"
}

fn keychain_account_for_path(path: &Path) -> String {
    let mut output = String::from("file:");
    for value in path.to_string_lossy().chars() {
        if value.is_ascii_alphanumeric() || value == '-' || value == '_' || value == '.' {
            output.push(value);
        } else {
            output.push('_');
        }
    }
    output
}

#[cfg(target_os = "macos")]
fn run_keychain(args: &[&str]) -> Result<String, String> {
    let output = Command::new("security")
        .args(args)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output()
        .map_err(|error| error.to_string())?;

    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
    }

    Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
}

#[cfg(not(target_os = "macos"))]
fn run_keychain(_args: &[&str]) -> Result<String, String> {
    Err("keychain_unavailable_on_this_platform".to_string())
}

fn save_keychain_secret(service: &str, account: &str, api_key: &str) -> Result<(), String> {
    run_keychain(&[
        "add-generic-password",
        "-s",
        service,
        "-a",
        account,
        "-w",
        api_key,
        "-U",
    ])
    .map(|_| ())
}

fn load_keychain_secret(service: &str, account: &str) -> Result<String, String> {
    run_keychain(&[
        "find-generic-password",
        "-s",
        service,
        "-a",
        account,
        "-w",
    ])
}

fn encrypt_provider_api_key(path: &Path, api_key: &str) -> Result<String, String> {
    if cfg!(windows) {
        let ciphertext = run_dpapi("protect", api_key)?;
        dpapi_cache_insert(&ciphertext, api_key);
        return serde_json::to_string_pretty(&serde_json::json!({
            "format": "dpapi-user-v1",
            "ciphertext": ciphertext
        }))
        .map_err(|error| error.to_string());
    }

    if cfg!(target_os = "macos") {
        let service = keychain_service();
        let account = keychain_account_for_path(path);
        save_keychain_secret(service, &account, api_key)?;
        return serde_json::to_string_pretty(&serde_json::json!({
            "format": "keychain-v1",
            "service": service,
            "account": account
        }))
        .map_err(|error| error.to_string());
    }

    serde_json::to_string_pretty(&serde_json::json!({
        "format": "plaintext-local-v1",
        "value": api_key
    }))
    .map_err(|error| error.to_string())
}

fn decrypt_provider_api_key(raw: &str) -> Result<Option<String>, String> {
    if let Ok(value) = serde_json::from_str::<serde_json::Value>(raw) {
        match value.get("format").and_then(|item| item.as_str()) {
            Some("dpapi-user-v1") => {
                return match value.get("ciphertext").and_then(|item| item.as_str()) {
                    Some(ciphertext) => dpapi_unprotect_cached(ciphertext).map(Some),
                    None => Ok(None),
                };
            }
            Some("keychain-v1") => {
                let service = value.get("service").and_then(|item| item.as_str());
                let account = value.get("account").and_then(|item| item.as_str());
                return match (service, account) {
                    (Some(service), Some(account)) => load_keychain_secret(service, account).map(Some),
                    _ => Ok(None),
                };
            }
            Some("plaintext-local-v1") => {
                return Ok(value
                    .get("value")
                    .and_then(|item| item.as_str())
                    .map(|item| item.to_string()));
            }
            Some(_) => return Ok(None),
            None => {}
        }
    }

    let legacy = raw.trim().to_string();
    if legacy.is_empty() {
        Ok(None)
    } else {
        Ok(Some(legacy))
    }
}

fn save_encrypted_api_key(path: &Path, api_key: &str) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    fs::write(path, encrypt_provider_api_key(path, api_key.trim())?)
        .map_err(|error| error.to_string())
}

fn load_encrypted_api_key(path: &Path) -> Result<Option<String>, String> {
    if !path.exists() {
        return Ok(None);
    }
    let raw = fs::read_to_string(path).map_err(|error| error.to_string())?;
    let decrypted = decrypt_provider_api_key(&raw)?;
    if let Some(api_key) = decrypted.as_ref() {
        if !raw.trim_start().starts_with('{') {
            fs::write(path, encrypt_provider_api_key(path, api_key)?)
                .map_err(|error| error.to_string())?;
        }
    }
    Ok(decrypted)
}

fn save_agent_api_key(app: &AppHandle, agent_id: &str, api_key: &str) -> Result<(), String> {
    let key_path = agent_api_key_path(app, agent_id)?;
    save_encrypted_api_key(&key_path, api_key)
}

fn read_json_object(path: &Path) -> Result<serde_json::Map<String, serde_json::Value>, String> {
    if !path.exists() {
        return Ok(serde_json::Map::new());
    }
    let content = fs::read_to_string(path).map_err(|error| error.to_string())?;
    let parsed: serde_json::Value = serde_json::from_str(&content).map_err(|error| error.to_string())?;
    Ok(parsed.as_object().cloned().unwrap_or_default())
}

fn copy_dir_all(source: &Path, target: &Path) -> Result<(), String> {
    fs::create_dir_all(target).map_err(|error| error.to_string())?;
    for entry in fs::read_dir(source).map_err(|error| error.to_string())? {
        let entry = entry.map_err(|error| error.to_string())?;
        let file_type = entry.file_type().map_err(|error| error.to_string())?;
        let next_target = target.join(entry.file_name());
        if file_type.is_dir() {
            copy_dir_all(&entry.path(), &next_target)?;
        } else {
            fs::copy(entry.path(), next_target).map_err(|error| error.to_string())?;
        }
    }
    Ok(())
}

fn write_openclaw_runtime_manifest(app: &AppHandle) -> Result<String, String> {
    let app_data = app.path().app_data_dir().map_err(|error| error.to_string())?;
    let first_run = app_data.join("desktop-first-run");
    let runtime_dir = app_data.join("openclaw-runtime");
    let source_cluster_path = first_run.join("cluster.config.json");
    let runtime_cluster_path = runtime_dir.join("cluster.config.json");
    let source_agent_model_config_path = first_run.join("agent-model-configs.json");
    let runtime_agent_model_config_path = runtime_dir.join("agent-model-configs.json");
    let source_agents_dir = first_run.join("agents");
    let runtime_agents_dir = runtime_dir.join("agents");
    let env_path = runtime_dir.join("openclaw.env");
    let manifest_path = runtime_dir.join("runtime-manifest.json");
    let applied_at = timestamp_string();

    fs::create_dir_all(&runtime_dir).map_err(|error| error.to_string())?;
    if source_cluster_path.exists() {
        fs::copy(&source_cluster_path, &runtime_cluster_path).map_err(|error| error.to_string())?;
    }
    if source_agent_model_config_path.exists() {
        fs::copy(&source_agent_model_config_path, &runtime_agent_model_config_path).map_err(|error| error.to_string())?;
    }
    if source_agents_dir.exists() {
        if runtime_agents_dir.exists() {
            fs::remove_dir_all(&runtime_agents_dir).map_err(|error| error.to_string())?;
        }
        copy_dir_all(&source_agents_dir, &runtime_agents_dir)?;
    }

    let env_contents = format!(
        "AGENT_CLUSTER_CONFIG_PATH={}\nHONEYCOMB_AGENT_MODEL_CONFIG_PATH={}\nHONEYCOMB_FIRST_RUN_AGENTS_DIR={}\n",
        runtime_cluster_path.to_string_lossy(),
        runtime_agent_model_config_path.to_string_lossy(),
        runtime_agents_dir.to_string_lossy()
    );
    fs::write(&env_path, env_contents).map_err(|error| error.to_string())?;

    let manifest = serde_json::json!({
        "schemaVersion": "honeycomb.openclaw.runtime.v1",
        "clusterConfigPath": runtime_cluster_path,
        "agentModelConfigPath": runtime_agent_model_config_path,
        "agentsDir": runtime_agents_dir,
        "openclawEnvPath": env_path,
        "appliedAt": applied_at
    });
    fs::write(
        &manifest_path,
        serde_json::to_string_pretty(&manifest).map_err(|error| error.to_string())?,
    )
    .map_err(|error| error.to_string())?;
    Ok(manifest_path.to_string_lossy().to_string())
}

#[tauri::command]
async fn verify_provider_connection(payload: ProviderPayload) -> Result<ProviderConnectionResult, String> {
    let provider_name = payload.provider_name.trim().to_string();
    call_chat_completion(
        &payload,
        vec![
            serde_json::json!({
                "role": "system",
                "content": "You verify that a model endpoint works. Reply with exactly OK."
            }),
            serde_json::json!({
                "role": "user",
                "content": "Reply OK if you can read this request."
            }),
        ],
        16,
    )
    .await?;
    Ok(ProviderConnectionResult {
        ok: true,
        message: format!("{} connection verified.", if provider_name.is_empty() { "Provider" } else { &provider_name }),
        openclaw_manifest_path: None,
    })
}

#[tauri::command]
async fn generate_first_run_suggestions(payload: SuggestionPayload) -> Result<InterviewSuggestions, String> {
    let language_name = if payload.language == "zh" { "Chinese" } else { "English" };
    let role_line = if payload.role.trim().is_empty() {
        "Role: unknown yet".to_string()
    } else {
        format!("Role: {}", payload.role.trim())
    };
    let work_line = if payload.daily_work.trim().is_empty() {
        "Daily work: unknown yet".to_string()
    } else {
        format!("Daily work: {}", payload.daily_work.trim())
    };
    let role_instruction = if payload.role.trim().is_empty() {
        "Role is unknown. Generate roleExamples from the industry/domain, and keep workOptions broad placeholders until a role is supplied.".to_string()
    } else {
        "Role is known. Generate workOptions from Role only. Do not use the industry/domain or daily work to add domain-specific nouns unless those nouns appear in Role itself.".to_string()
    };
    let content = call_chat_completion(
        &payload.provider,
        vec![
            serde_json::json!({
                "role": "system",
                "content": "You generate concise onboarding UI suggestions for a local multi-agent work panel. Return strict JSON only. Do not include secrets."
            }),
            serde_json::json!({
                "role": "user",
                "content": format!(
                    "Language: {language_name}\nIndustry/domain for roleExamples only: {}\n{role_line}\n{work_line}\nRule: {role_instruction}\nReturn JSON with exactly this shape: {{\"roleExamples\":[3 or 4 short role names],\"workOptions\":[4 concrete daily work options],\"qualityExamples\":[4 short examples of excellent output for this user's role and work]}}. Keep each item short. Never mix stale occupations from previous answers.",
                    payload.industry.trim()
                )
            }),
        ],
        260,
    )
    .await?;
    parse_suggestions(&content)
}

#[tauri::command]
async fn save_first_run_setup(app: AppHandle, payload: String) -> Result<String, String> {
    let parsed: FirstRunPayload = serde_json::from_str(&payload).map_err(|error| error.to_string())?;
    let app_data = app.path().app_data_dir().map_err(|error| error.to_string())?;
    let out_dir = app_data.join("desktop-first-run");
    let agents_dir = out_dir.join("agents");
    let provider = parsed.provider.clone();

    fs::create_dir_all(&agents_dir).map_err(|error| error.to_string())?;
    fs::write(
        out_dir.join("first-run-profile.json"),
        serde_json::to_string_pretty(&serde_json::json!({
            "provider": provider,
            "interview": parsed.interview,
            "profile": parsed.profile
        }))
        .map_err(|error| error.to_string())?,
    )
    .map_err(|error| error.to_string())?;
    fs::write(
        out_dir.join("cluster.config.json"),
        serde_json::to_string_pretty(&parsed.cluster_config).map_err(|error| error.to_string())?,
    )
    .map_err(|error| error.to_string())?;

    for agent in parsed.agents {
        let target = safe_join(&out_dir, &agent.path)?;
        if let Some(parent) = target.parent() {
            fs::create_dir_all(parent).map_err(|error| error.to_string())?;
        }
        fs::write(target, agent.contents).map_err(|error| error.to_string())?;
    }

    if let Ok(Some(api_key)) = load_provider_api_key_inner(&app) {
        let model = parsed.provider.get("model").and_then(|value| value.as_str()).unwrap_or("").trim();
        if !model.is_empty() {
            save_agent_api_key(&app, "panel-supervisor-agent", &api_key)?;
            let config_path = out_dir.join("agent-model-configs.json");
            let mut configs = read_json_object(&config_path)?;
            let applied_at = timestamp_string();
            configs.insert(
                "panel-supervisor-agent".to_string(),
                serde_json::json!({
                    "providerName": parsed.provider.get("providerName").and_then(|value| value.as_str()).unwrap_or("DeepSeek"),
                    "baseUrl": parsed.provider.get("baseUrl").and_then(|value| value.as_str()).unwrap_or("https://api.deepseek.com"),
                    "model": model,
                    "apiKeyConfigured": true,
                    "verifiedAt": applied_at,
                    "appliedAt": applied_at
                }),
            );
            fs::write(
                &config_path,
                serde_json::to_string_pretty(&configs).map_err(|error| error.to_string())?,
            )
            .map_err(|error| error.to_string())?;
        }
    }

    let _ = write_openclaw_runtime_manifest(&app);

    Ok(out_dir.to_string_lossy().to_string())
}

#[tauri::command]
fn load_first_run_setup(app: AppHandle) -> Result<Option<String>, String> {
    let app_data = app.path().app_data_dir().map_err(|error| error.to_string())?;
    let profile_path = app_data.join("desktop-first-run").join("first-run-profile.json");
    if !profile_path.exists() {
        return Ok(None);
    }
    fs::read_to_string(profile_path)
        .map(Some)
        .map_err(|error| error.to_string())
}

#[tauri::command]
async fn load_agent_model_configs(app: AppHandle) -> Result<Option<String>, String> {
    let config_path = first_run_dir(&app)?.join("agent-model-configs.json");
    if !config_path.exists() {
        return Ok(None);
    }
    let mut persisted = read_json_object(&config_path)?;
    let mut response = persisted.clone();
    let mut changed = false;
    let agent_ids: Vec<String> = persisted.keys().cloned().collect();

    for agent_id in agent_ids {
        let mut configured_by_key_file = false;
        let legacy_key = persisted
            .get(&agent_id)
            .and_then(|value| value.as_object())
            .and_then(|object| object.get("apiKey"))
            .and_then(|value| value.as_str())
            .unwrap_or("")
            .trim()
            .to_string();

        if !legacy_key.is_empty() {
            save_agent_api_key(&app, &agent_id, &legacy_key)?;
            configured_by_key_file = true;
        }

        if let Some(value) = persisted.get_mut(&agent_id) {
            if let Some(object) = value.as_object_mut() {
                if object.remove("apiKey").is_some() {
                    changed = true;
                }
                if configured_by_key_file {
                    object.insert("apiKeyConfigured".to_string(), serde_json::json!(true));
                }
            }
        }

        let key_path = agent_api_key_path(&app, &agent_id)?;
        let api_key = load_encrypted_api_key(&key_path)?;
        if let Some(value) = response.get_mut(&agent_id) {
            if let Some(object) = value.as_object_mut() {
                object.remove("apiKey");
                if let Some(api_key) = api_key {
                    object.insert("apiKey".to_string(), serde_json::json!(api_key));
                    object.insert("apiKeyConfigured".to_string(), serde_json::json!(true));
                } else if configured_by_key_file {
                    object.insert("apiKey".to_string(), serde_json::json!(legacy_key));
                    object.insert("apiKeyConfigured".to_string(), serde_json::json!(true));
                }
            }
        }
    }

    if changed {
        fs::write(
            &config_path,
            serde_json::to_string_pretty(&persisted).map_err(|error| error.to_string())?,
        )
        .map_err(|error| error.to_string())?;
    }

    serde_json::to_string_pretty(&response)
        .map(Some)
        .map_err(|error| error.to_string())
}

#[tauri::command]
async fn save_agent_model_config(
    app: AppHandle,
    payload: AgentModelConfigPayload,
) -> Result<ProviderConnectionResult, String> {
    let provider = ProviderPayload {
        provider_name: payload.provider_name.trim().to_string(),
        base_url: payload.base_url.trim().to_string(),
        model: payload.model.trim().to_string(),
        api_key: payload.api_key.trim().to_string(),
    };
    let provider_name = provider.provider_name.clone();
    call_chat_completion(
        &provider,
        vec![
            serde_json::json!({
                "role": "system",
                "content": "You verify that a model endpoint works. Reply with exactly OK."
            }),
            serde_json::json!({
                "role": "user",
                "content": "Reply OK if this agent model configuration is valid."
            }),
        ],
        16,
    )
    .await?;

    let out_dir = first_run_dir(&app)?;
    fs::create_dir_all(&out_dir).map_err(|error| error.to_string())?;
    save_agent_api_key(&app, payload.agent_id.trim(), provider.api_key.trim())?;
    let config_path = out_dir.join("agent-model-configs.json");
    let mut configs = read_json_object(&config_path)?;
    let applied_at = timestamp_string();
    configs.insert(
        payload.agent_id.trim().to_string(),
        serde_json::json!({
            "providerName": provider.provider_name,
            "baseUrl": provider.base_url,
            "model": provider.model,
            "apiKeyConfigured": true,
            "verifiedAt": applied_at,
            "appliedAt": applied_at
        }),
    );
    fs::write(
        &config_path,
        serde_json::to_string_pretty(&configs).map_err(|error| error.to_string())?,
    )
    .map_err(|error| error.to_string())?;
    let manifest_path = write_openclaw_runtime_manifest(&app)?;
    Ok(ProviderConnectionResult {
        ok: true,
        message: format!("{} connection verified.", if provider_name.is_empty() { "Provider" } else { &provider_name }),
        openclaw_manifest_path: Some(manifest_path),
    })
}

#[tauri::command]
fn apply_openclaw_agent_setup(app: AppHandle) -> Result<String, String> {
    write_openclaw_runtime_manifest(&app)
}

#[tauri::command]
async fn save_provider_api_key(app: AppHandle, payload: String) -> Result<(), String> {
    let key_path = provider_api_key_path(&app)?;
    save_encrypted_api_key(&key_path, payload.trim())
}

fn load_provider_api_key_inner(app: &AppHandle) -> Result<Option<String>, String> {
    let key_path = provider_api_key_path(app)?;
    if !key_path.exists() {
        return Ok(None);
    }
    load_encrypted_api_key(&key_path)
}

#[tauri::command]
async fn load_provider_api_key(app: AppHandle) -> Result<Option<String>, String> {
    load_provider_api_key_inner(&app)
}

#[tauri::command]
fn load_api_auth_token(app: AppHandle) -> Result<Option<String>, String> {
    let app_data = app.path().app_data_dir().map_err(|error| error.to_string())?;
    let token_path = app_data.join("honeycomb-api-token.txt");
    if !token_path.exists() {
        return Ok(None);
    }
    fs::read_to_string(token_path)
        .map(|token| {
            let trimmed = token.trim().to_string();
            if trimmed.is_empty() {
                None
            } else {
                Some(trimmed)
            }
        })
        .map_err(|error| error.to_string())
}

fn run_hidden_powershell(script: &str) -> Result<String, String> {
    let mut command = Command::new("powershell");
    command
        .args([
            "-NoProfile",
            "-Sta",
            "-ExecutionPolicy",
            "Bypass",
            "-Command",
            script,
        ])
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(windows)]
    command.creation_flags(0x0800_0000);

    let output = command.output().map_err(|error| error.to_string())?;
    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
    }
    Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
}

#[tauri::command]
fn pick_directory() -> Result<Option<String>, String> {
    #[cfg(windows)]
    {
        let script = "$ErrorActionPreference='Stop';Add-Type -AssemblyName System.Windows.Forms;$dialog=New-Object System.Windows.Forms.FolderBrowserDialog;$dialog.Description='Choose or create a Honeycomb project folder';$dialog.ShowNewFolderButton=$true;if($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK){[Console]::Out.Write($dialog.SelectedPath)}";
        let selected = run_hidden_powershell(script)?;
        Ok(if selected.is_empty() { None } else { Some(selected) })
    }

    #[cfg(not(windows))]
    {
        Ok(None)
    }
}

#[tauri::command]
fn pick_files() -> Result<Vec<String>, String> {
    #[cfg(windows)]
    {
        let script = "$ErrorActionPreference='Stop';Add-Type -AssemblyName System.Windows.Forms;$dialog=New-Object System.Windows.Forms.OpenFileDialog;$dialog.Title='Add photos and files';$dialog.Multiselect=$true;if($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK){[Console]::Out.Write(($dialog.FileNames -join \"`n\"))}";
        let selected = run_hidden_powershell(script)?;
        Ok(selected
            .lines()
            .map(|line| line.trim().to_string())
            .filter(|line| !line.is_empty())
            .collect())
    }

    #[cfg(not(windows))]
    {
        Ok(Vec::new())
    }
}

#[tauri::command]
async fn download_url_to_desktop(
    app: AppHandle,
    payload: DownloadToDesktopPayload,
) -> Result<DownloadToDesktopResult, String> {
    let url = payload.url.trim();
    if url.is_empty() || !(url.starts_with("https://") || url.starts_with("http://")) {
        return Err("download_url_invalid".to_string());
    }

    let desktop_dir = app.path().desktop_dir().map_err(|error| error.to_string())?;
    let target = unique_desktop_file_path(&desktop_dir, &payload.file_name);
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(120))
        .build()
        .map_err(|error| error.to_string())?;
    let mut request = client.get(url);
    if let Some(authorization) = payload
        .authorization
        .as_ref()
        .map(|value| value.trim())
        .filter(|value| !value.is_empty())
    {
        request = request.header(reqwest::header::AUTHORIZATION, authorization);
    }

    let mut response = request.send().await.map_err(|error| error.to_string())?;
    let status = response.status();
    if !status.is_success() {
        return Err(format!("download_http_{}", status.as_u16()));
    }

    let max_bytes = payload
        .expected_size_bytes
        .unwrap_or(500 * 1024 * 1024);
    if let Some(content_length) = response.content_length() {
        if content_length > max_bytes {
            return Err("download_size_limit_exceeded".to_string());
        }
        if payload.expected_size_bytes.is_some() && content_length != max_bytes {
            return Err("download_size_mismatch".to_string());
        }
    }

    let target_name = target
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("honeycomb-artifact");
    cleanup_stale_delivery_parts(&desktop_dir, target_name);
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    let temporary = target.with_file_name(format!(
        ".{target_name}.{}.{}.part",
        std::process::id(),
        nonce
    ));
    let mut output = OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(&temporary)
        .map_err(|error| error.to_string())?;
    let mut received = 0_u64;
    let mut checksum = Sha256::new();
    let transfer_result: Result<(), String> = async {
        while let Some(chunk) = response.chunk().await.map_err(|error| error.to_string())? {
            received = received.saturating_add(chunk.len() as u64);
            if received > max_bytes {
                return Err("download_size_limit_exceeded".to_string());
            }
            checksum.update(chunk.as_ref());
            output
                .write_all(chunk.as_ref())
                .map_err(|error| error.to_string())?;
        }
        if let Some(expected) = payload.expected_size_bytes {
            if received != expected {
                return Err("download_size_mismatch".to_string());
            }
        }
        output.sync_all().map_err(|error| error.to_string())?;
        Ok(())
    }
    .await;
    drop(output);
    if let Err(error) = transfer_result {
        let _ = fs::remove_file(&temporary);
        return Err(error);
    }
    let checksum_sha256 = format!("{:x}", checksum.finalize());
    if let Some(expected) = payload
        .expected_checksum_sha256
        .as_ref()
        .map(|value| value.trim())
        .filter(|value| !value.is_empty())
    {
        if !checksum_sha256.eq_ignore_ascii_case(expected) {
            let _ = fs::remove_file(&temporary);
            return Err("download_checksum_mismatch".to_string());
        }
    }
    if let Err(error) = fs::rename(&temporary, &target) {
        let _ = fs::remove_file(&temporary);
        return Err(error.to_string());
    }
    Ok(DownloadToDesktopResult {
        path: target.to_string_lossy().to_string(),
        bytes: received,
        checksum_sha256,
    })
}

#[tauri::command]
fn open_in_file_explorer(path: String) -> Result<(), String> {
    let trimmed = path.trim();
    if trimmed.is_empty() {
        return Err("path_empty".to_string());
    }

    #[cfg(windows)]
    {
        let target = PathBuf::from(trimmed);
        let argument = if target.is_file() {
            format!("/select,{}", target.display())
        } else {
            target.display().to_string()
        };
        Command::new("explorer.exe")
            .arg(argument)
            .spawn()
            .map(|_| ())
            .map_err(|error| error.to_string())
    }

    #[cfg(target_os = "macos")]
    {
        Command::new("open")
            .arg(trimmed)
            .spawn()
            .map(|_| ())
            .map_err(|error| error.to_string())
    }

    #[cfg(all(unix, not(target_os = "macos")))]
    {
        Command::new("xdg-open")
            .arg(trimmed)
            .spawn()
            .map(|_| ())
            .map_err(|error| error.to_string())
    }
}

fn is_animation_preview_mode() -> bool {
    std::env::var("HONEYCOMB_ANIMATION_PREVIEW")
        .map(|value| matches!(value.to_ascii_lowercase().as_str(), "1" | "true" | "yes" | "on"))
        .unwrap_or(false)
}

fn single_instance_addr(animation_preview_mode: bool) -> &'static str {
    if animation_preview_mode {
        ANIMATION_PREVIEW_INSTANCE_ADDR
    } else {
        SINGLE_INSTANCE_ADDR
    }
}

fn focus_window(app: &AppHandle, label: &str) {
    if let Some(window) = app.get_webview_window(label) {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

fn open_animation_preview_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("animation-preview") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
        return;
    }

    match WebviewWindowBuilder::new(
        app,
        "animation-preview",
        WebviewUrl::App("animation-preview.html".into()),
    )
    .title("Honeycomb 动画分镜预览")
    .inner_size(980.0, 720.0)
    .min_inner_size(760.0, 560.0)
    .resizable(true)
    .build()
    {
        Ok(window) => {
            let app_for_close = app.clone();
            window.on_window_event(move |event| {
                if matches!(event, WindowEvent::CloseRequested { .. }) {
                    app_for_close.exit(0);
                }
            });
            let _ = window.show();
            let _ = window.set_focus();
        }
        Err(error) => eprintln!("failed to open animation preview window: {error}"),
    }
}

fn notify_existing_instance(addr: &str) {
    if let Ok(mut stream) = TcpStream::connect(addr) {
        let _ = stream.write_all(b"focus");
    }
}

fn main() {
    let animation_preview_mode = is_animation_preview_mode();
    let instance_addr = single_instance_addr(animation_preview_mode);
    let single_instance_listener = match TcpListener::bind(instance_addr) {
        Ok(listener) => listener,
        Err(_) => {
            notify_existing_instance(instance_addr);
            return;
        }
    };

    tauri::Builder::default()
        .setup(move |app| {
            let app_handle = app.handle().clone();
            thread::spawn(move || {
                for stream in single_instance_listener.incoming() {
                    if stream.is_ok() {
                        if animation_preview_mode {
                            open_animation_preview_window(&app_handle);
                        } else {
                            focus_window(&app_handle, "main");
                        }
                    }
                }
            });
            if animation_preview_mode {
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.hide();
                }
                open_animation_preview_window(app.handle());
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            verify_provider_connection,
            generate_first_run_suggestions,
            save_first_run_setup,
            load_first_run_setup,
            load_agent_model_configs,
            save_agent_model_config,
            apply_openclaw_agent_setup,
            save_provider_api_key,
            load_provider_api_key,
            load_api_auth_token,
            download_url_to_desktop,
            open_in_file_explorer,
            pick_directory,
            pick_files
        ])
        .run(tauri::generate_context!())
        .expect("error while running Honeycomb desktop shell");
}
