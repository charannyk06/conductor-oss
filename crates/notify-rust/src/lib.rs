use std::fmt;
use std::process::Command;

pub type Result<T> = std::result::Result<T, Error>;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Urgency {
    Low,
    Normal,
    Critical,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Hint {
    SoundName(String),
}

#[derive(Debug, Clone, Default)]
pub struct Notification {
    appname: Option<String>,
    summary: Option<String>,
    body: Option<String>,
    urgency: Option<Urgency>,
    sound_name: Option<String>,
}

impl Notification {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn appname(&mut self, value: &str) -> &mut Self {
        self.appname = Some(value.to_string());
        self
    }

    pub fn summary(&mut self, value: &str) -> &mut Self {
        self.summary = Some(value.to_string());
        self
    }

    pub fn body(&mut self, value: &str) -> &mut Self {
        self.body = Some(value.to_string());
        self
    }

    pub fn urgency(&mut self, value: Urgency) -> &mut Self {
        self.urgency = Some(value);
        self
    }

    pub fn hint(&mut self, value: Hint) -> &mut Self {
        match value {
            Hint::SoundName(name) => self.sound_name = Some(name),
        }
        self
    }

    pub fn show(&self) -> Result<()> {
        #[cfg(target_os = "macos")]
        {
            return self.show_macos();
        }

        #[cfg(target_os = "linux")]
        {
            return self.show_linux();
        }

        #[cfg(not(any(target_os = "macos", target_os = "linux")))]
        {
            Ok(())
        }
    }

    #[cfg(target_os = "macos")]
    fn show_macos(&self) -> Result<()> {
        let summary = escape_applescript(self.summary.as_deref().unwrap_or("Conductor"));
        let body = escape_applescript(self.body.as_deref().unwrap_or_default());
        let sound = self
            .sound_name
            .as_deref()
            .filter(|value| !value.trim().is_empty())
            .map(|value| format!(" sound name \"{}\"", escape_applescript(value)))
            .unwrap_or_default();
        let script = format!("display notification \"{body}\" with title \"{summary}\"{sound}");

        run_command("osascript", ["-e", script.as_str()])
    }

    #[cfg(target_os = "linux")]
    fn show_linux(&self) -> Result<()> {
        let mut args = Vec::new();
        if let Some(appname) = self
            .appname
            .as_deref()
            .filter(|value| !value.trim().is_empty())
        {
            args.push("--app-name");
            args.push(appname);
        }
        match self.urgency.unwrap_or(Urgency::Normal) {
            Urgency::Low => {
                args.push("--urgency=low");
            }
            Urgency::Normal => {
                args.push("--urgency=normal");
            }
            Urgency::Critical => {
                args.push("--urgency=critical");
            }
        }
        args.push(self.summary.as_deref().unwrap_or("Conductor"));
        args.push(self.body.as_deref().unwrap_or_default());
        run_command("notify-send", args)
    }
}

#[cfg(target_os = "macos")]
fn escape_applescript(value: &str) -> String {
    value.replace('\\', "\\\\").replace('"', "\\\"")
}

fn run_command<I, S>(program: &str, args: I) -> Result<()>
where
    I: IntoIterator<Item = S>,
    S: AsRef<str>,
{
    let collected = args
        .into_iter()
        .map(|value| value.as_ref().to_string())
        .collect::<Vec<_>>();
    let status = Command::new(program)
        .args(collected.iter().map(String::as_str))
        .status()
        .map_err(|source| Error::command(program, source))?;
    if status.success() {
        Ok(())
    } else {
        Err(Error::status(program, status.code()))
    }
}

#[derive(Debug)]
pub struct Error {
    message: String,
}

impl Error {
    fn command(program: &str, source: std::io::Error) -> Self {
        Self {
            message: format!("{program} failed: {source}"),
        }
    }

    fn status(program: &str, code: Option<i32>) -> Self {
        Self {
            message: format!("{program} exited unsuccessfully: {:?}", code),
        }
    }
}

impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.message)
    }
}

impl std::error::Error for Error {}
