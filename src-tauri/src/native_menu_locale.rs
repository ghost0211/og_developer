// Keep native labels aligned with frontend localeFromLanguageTag, including
// before the WebView has reported its locale: all Chinese tags use zh-CN.
fn is_chinese_locale(locale: &str) -> bool {
    let normalized = locale.replace('_', "-").to_ascii_lowercase();
    normalized == "zh" || normalized.starts_with("zh-")
}

pub(crate) fn app_menu_copy_support_info_label(locale: &str) -> &'static str {
    if is_chinese_locale(locale) {
        "复制支持信息"
    } else {
        "Copy Support Info"
    }
}

pub(crate) fn app_menu_quit_label(locale: &str, app_name: &str) -> String {
    if is_chinese_locale(locale) {
        format!("退出 {app_name}")
    } else {
        format!("Quit {app_name}")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn all_chinese_system_locales_use_simplified_chinese() {
        for locale in ["zh", "zh-CN", "zh-TW", "zh-HK", "zh-MO", "zh-Hant", "ZH_Hant_TW"] {
            assert_eq!(app_menu_copy_support_info_label(locale), "复制支持信息", "{locale}");
            assert_eq!(app_menu_quit_label(locale, "OG Developer"), "退出 OG Developer", "{locale}");
        }
    }

    #[test]
    fn english_system_locales_use_english() {
        for locale in ["en", "en-US", "en-GB", "EN_US"] {
            assert_eq!(app_menu_copy_support_info_label(locale), "Copy Support Info", "{locale}");
            assert_eq!(app_menu_quit_label(locale, "OG Developer"), "Quit OG Developer", "{locale}");
        }
    }

    #[test]
    fn removed_and_unknown_system_locales_fall_back_to_english() {
        for locale in ["ja-JP", "ko-KR", "es-ES", "it-IT", "pt-BR", "fr-FR", "", "zhh"] {
            assert_eq!(app_menu_copy_support_info_label(locale), "Copy Support Info", "{locale}");
            assert_eq!(app_menu_quit_label(locale, "OG Developer"), "Quit OG Developer", "{locale}");
        }
    }
}
