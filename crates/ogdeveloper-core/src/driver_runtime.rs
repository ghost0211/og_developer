use serde::{Deserialize, Serialize};

use crate::connection::AppState;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct DriverRuntimeInfo {
    pub id: String,
    pub driver_key: String,
    pub label: String,
    pub kind: String,
    pub source: String,
    pub status: String,
    pub pid: Option<u32>,
    pub memory_bytes: Option<u64>,
    pub cpu_percent: Option<f32>,
    pub uptime_seconds: Option<u64>,
    pub version: Option<String>,
    pub last_error: Option<String>,
    pub can_stop: bool,
    pub can_restart: bool,
    pub control_unavailable_reason: Option<String>,
    #[serde(default)]
    pub protocol_mode: Option<String>,
    #[serde(default)]
    pub active_sessions: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
pub struct DriverRuntimeSummary {
    pub running_count: usize,
    pub total_memory_bytes: u64,
    pub last_error: Option<String>,
    pub health: String,
    pub runtimes: Vec<DriverRuntimeInfo>,
}

pub async fn collect_driver_runtime_summary(_state: &AppState) -> DriverRuntimeSummary {
    DriverRuntimeSummary {
        running_count: 0,
        total_memory_bytes: 0,
        last_error: None,
        health: "ok".to_string(),
        runtimes: vec![],
    }
}

pub async fn stop_driver_runtime(_state: &AppState, _runtime_id: &str) -> Result<(), String> {
    Ok(())
}

pub async fn restart_driver_runtime(_state: &AppState, _runtime_id: &str) -> Result<(), String> {
    Ok(())
}
