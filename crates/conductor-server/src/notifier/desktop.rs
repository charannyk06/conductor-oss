use anyhow::Result;
use notify_rust::{Hint, Notification, Urgency};

use crate::notifier::{NotificationEvent, NotificationPriority};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct DesktopNotifierConfig {
    pub sound: bool,
}

impl Default for DesktopNotifierConfig {
    fn default() -> Self {
        Self { sound: true }
    }
}

#[derive(Debug, Clone)]
pub struct DesktopNotifier {
    config: DesktopNotifierConfig,
}

impl DesktopNotifier {
    pub fn new(config: DesktopNotifierConfig) -> Self {
        Self { config }
    }

    pub async fn notify(&self, event: &NotificationEvent) -> Result<()> {
        let title = format_title(event);
        let sound = should_play_sound(event.priority, self.config.sound);

        let mut notification = Notification::new();
        notification
            .appname("Conductor")
            .summary(&title)
            .body(&event.message)
            .urgency(priority_urgency(event.priority));

        if sound {
            notification.hint(Hint::SoundName("default".to_string()));
        }

        notification.show()?;
        Ok(())
    }
}

pub fn should_play_sound(priority: NotificationPriority, sound_enabled: bool) -> bool {
    sound_enabled && priority == NotificationPriority::Urgent
}

pub fn format_title(event: &NotificationEvent) -> String {
    let prefix = if event.priority == NotificationPriority::Urgent {
        "URGENT"
    } else {
        "Conductor"
    };
    format!("{prefix} [{}]", event.session_id)
}

fn priority_urgency(priority: NotificationPriority) -> Urgency {
    match priority {
        NotificationPriority::Urgent => Urgency::Critical,
        NotificationPriority::Action | NotificationPriority::Warning => Urgency::Normal,
        NotificationPriority::Info => Urgency::Low,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::notifier::NotificationEvent;

    #[test]
    fn urgent_notifications_enable_sound_when_configured() {
        assert!(should_play_sound(NotificationPriority::Urgent, true));
        assert!(!should_play_sound(NotificationPriority::Info, true));
        assert!(!should_play_sound(NotificationPriority::Urgent, false));
    }

    #[test]
    fn title_matches_typescript_prefix_convention() {
        let urgent = NotificationEvent::new(
            "session-1",
            "demo",
            "session.needs_input",
            NotificationPriority::Urgent,
            "Need input",
        );
        let info = NotificationEvent::new(
            "session-2",
            "demo",
            "session.completed",
            NotificationPriority::Info,
            "All done",
        );

        assert_eq!(format_title(&urgent), "URGENT [session-1]");
        assert_eq!(format_title(&info), "Conductor [session-2]");
    }

    #[test]
    fn default_config_keeps_sound_enabled() {
        let config = DesktopNotifierConfig::default();
        assert!(config.sound);
    }
}
