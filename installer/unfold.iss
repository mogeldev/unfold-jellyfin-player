; Inno Setup script. Needs dist\Unfold (tools\build.ps1). Build with tools\make_installer.ps1
#define AppName "Unfold – Jellyfin Player"
#define AppVersion "0.3.1"

[Setup]
AppId={{A3F1C2D4-5B6E-4789-8A0B-1C2D3E4F5A6B}
AppName={#AppName}
AppVersion={#AppVersion}
DefaultDirName={autopf}\Unfold
DefaultGroupName={#AppName}
DisableProgramGroupPage=yes
; Per-user installation, no administrator rights
PrivilegesRequired=lowest
OutputDir=out
OutputBaseFilename=Unfold-Setup-{#AppVersion}
Compression=lzma2
SolidCompression=yes
WizardStyle=modern
SetupIconFile=..\assets\icon.ico
UninstallDisplayName={#AppName}
UninstallDisplayIcon={app}\Unfold.exe
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible

[Languages]
Name: "german"; MessagesFile: "compiler:Languages\German.isl"
Name: "english"; MessagesFile: "compiler:Default.isl"
Name: "french"; MessagesFile: "compiler:Languages\French.isl"
Name: "spanish"; MessagesFile: "compiler:Languages\Spanish.isl"
Name: "portuguese"; MessagesFile: "compiler:Languages\Portuguese.isl"
Name: "brazilianportuguese"; MessagesFile: "compiler:Languages\BrazilianPortuguese.isl"

[Tasks]
Name: "desktopicon"; Description: "{cm:CreateDesktopIcon}"; GroupDescription: "{cm:AdditionalIcons}"; Flags: unchecked

[Files]
Source: "..\dist\Unfold\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{autoprograms}\{#AppName}"; Filename: "{app}\Unfold.exe"
Name: "{autodesktop}\{#AppName}"; Filename: "{app}\Unfold.exe"; Tasks: desktopicon

[Run]
Filename: "{app}\Unfold.exe"; Description: "{cm:LaunchProgram,{#AppName}}"; Flags: nowait postinstall skipifsilent
