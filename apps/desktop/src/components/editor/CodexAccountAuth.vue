<script setup lang="ts">
import { computed, onUnmounted, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { Button } from "@/components/ui/button";
import * as api from "@/lib/backend/api";
import type { AiConfig } from "@/types/ai";
import { copyToClipboard } from "@/lib/common/clipboard";
import { isTauriRuntime } from "@/lib/backend/tauriRuntime";

const props = defineProps<{ accountId?: string; config: AiConfig }>();
const emit = defineEmits<{ "update:accountId": [value: string | undefined] }>();
const { t } = useI18n();
const busy = ref(false);
const checking = ref(false);
const confirmDisconnect = ref(false);
const authenticated = ref(false);
const accountLabel = ref("");
const error = ref("");
const session = ref<Awaited<ReturnType<typeof api.aiCodexAuthBegin>> | null>(null);
let timer: ReturnType<typeof setTimeout> | undefined;
let generation = 0;
const safeVerificationUrl = computed(() => {
  // Never render an arbitrary URL supplied by an authentication service.
  try {
    const url = new URL(session.value?.verificationUrl ?? "");
    return url.origin === "https://auth.openai.com" ? url.href : "";
  } catch {
    return "";
  }
});

async function openLogin() {
  const url = safeVerificationUrl.value;
  if (!url) return;
  try {
    if (isTauriRuntime()) {
      const { open } = await import("@tauri-apps/plugin-shell");
      await open(url);
    } else {
      window.open(url, "_blank", "noopener,noreferrer");
    }
  } catch (e) {
    error.value = String(e);
  }
}
function stopPolling() {
  generation++;
  if (timer) clearTimeout(timer);
  timer = undefined;
  checking.value = false;
}
async function cancelLogin() {
  stopPolling();
  const previous = session.value;
  session.value = null;
  busy.value = false;
  if (previous) await api.aiCodexAuthCancel(previous.sessionId).catch(() => {});
}
async function checkStatus() {
  const id = props.accountId;
  const request = ++generation;
  authenticated.value = false;
  accountLabel.value = "";
  if (!id) return;
  checking.value = true;
  try {
    const status = await api.aiCodexAuthStatus(id);
    if (request !== generation || props.accountId !== id) return;
    authenticated.value = status.authenticated;
    accountLabel.value = status.accountLabel ?? "";
  } catch (e) {
    if (request === generation) error.value = String(e);
  } finally {
    if (request === generation) checking.value = false;
  }
}
async function poll(request: number) {
  if (request !== generation || !session.value) return;
  try {
    const result = await api.aiCodexAuthPoll(session.value.sessionId);
    if (request !== generation) return;
    if (result.status === "authorized" && result.oauthAccountId) {
      session.value = null;
      busy.value = false;
      authenticated.value = true;
      emit("update:accountId", result.oauthAccountId);
      return;
    }
    if (result.status !== "pending") {
      await cancelLogin();
      error.value = t("ai.codexLoginExpired");
      return;
    }
    timer = setTimeout(() => void poll(request), Math.max(1000, session.value.intervalSeconds * 1000));
  } catch (e) {
    if (request !== generation) return;
    await cancelLogin();
    error.value = String(e);
  }
}
async function login() {
  await cancelLogin();
  const request = generation;
  busy.value = true;
  error.value = "";
  try {
    const result = await api.aiCodexAuthBegin(props.config);
    if (request !== generation) {
      await api.aiCodexAuthCancel(result.sessionId).catch(() => {});
      return;
    }
    session.value = result;
    timer = setTimeout(() => void poll(request), Math.max(1000, result.intervalSeconds * 1000));
  } catch (e) {
    if (request === generation) {
      busy.value = false;
      error.value = String(e);
    }
  }
}
async function disconnect() {
  if (!props.accountId) return;
  confirmDisconnect.value = false;
  busy.value = true;
  error.value = "";
  try {
    await api.aiCodexAuthDisconnect(props.accountId);
    authenticated.value = false;
    emit("update:accountId", undefined);
  } catch (e) {
    error.value = String(e);
  } finally {
    busy.value = false;
  }
}
async function copyCode() {
  if (!session.value) return;
  try {
    await copyToClipboard(session.value.userCode);
  } catch (e) {
    error.value = String(e);
  }
}
watch(
  () => props.accountId,
  () => {
    confirmDisconnect.value = false;
    error.value = "";
    void cancelLogin();
    void checkStatus();
  },
  { immediate: true },
);
onUnmounted(() => void cancelLogin());
</script>

<template>
  <div class="space-y-2 rounded-md border p-3 text-xs" data-testid="codex-account-auth">
    <p class="font-medium">{{ t("ai.codexAccountAuth") }}</p>
    <p class="text-muted-foreground">{{ t("ai.codexAccountHint") }}</p>
    <p v-if="checking">{{ t("ai.codexChecking") }}</p>
    <p v-else-if="authenticated" class="text-emerald-600">{{ t("ai.codexConnected") }} {{ accountLabel }}</p>
    <p v-else-if="accountId" class="text-amber-600">{{ t("ai.codexReconnect") }}</p>
    <div v-if="session" class="space-y-2">
      <p>{{ t("ai.codexDeviceInstructions") }}</p>
      <div class="flex items-center gap-2">
        <code class="select-all rounded bg-muted px-2 py-1 text-base font-semibold">{{ session.userCode }}</code>
        <Button type="button" size="sm" variant="outline" @click="copyCode">{{ t("common.copy") }}</Button>
      </div>
      <a v-if="safeVerificationUrl" :href="safeVerificationUrl" target="_blank" rel="noopener noreferrer" class="break-all text-primary underline" @click.prevent="openLogin">{{ t("ai.codexOpenLogin") }}</a>
      <p class="text-muted-foreground">{{ t("ai.codexWaiting") }}</p>
    </div>
    <p v-if="error" class="whitespace-pre-wrap break-all text-destructive" role="alert">{{ error }}</p>
    <div v-if="confirmDisconnect" class="space-y-2 rounded border border-amber-500/30 p-2">
      <p>{{ t("ai.codexDisconnectConfirm") }}</p>
      <Button type="button" size="sm" variant="outline" :disabled="busy" @click="disconnect">{{ t("common.confirm") }}</Button>
      <Button type="button" size="sm" variant="ghost" @click="confirmDisconnect = false">{{ t("common.cancel") }}</Button>
    </div>
    <div class="flex gap-2">
      <Button v-if="!session" type="button" size="sm" variant="outline" :disabled="busy || checking" @click="login">{{ authenticated ? t("ai.codexSignInAgain") : t("ai.codexSignIn") }}</Button>
      <Button v-if="session" type="button" size="sm" variant="outline" @click="cancelLogin">{{ t("common.cancel") }}</Button>
      <Button v-if="accountId && !session" type="button" size="sm" variant="ghost" :disabled="busy || checking" @click="confirmDisconnect = true">{{ t("ai.codexDisconnect") }}</Button>
    </div>
  </div>
</template>
