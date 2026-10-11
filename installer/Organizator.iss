; Installateur d'Organizator (Inno Setup 6).
;
; Installation par utilisateur, sans droits d'administrateur, dans %LOCALAPPDATA%\Programs\Organizator :
; l'executable autonome (runtime .NET embarque, voir publish.ps1 -SelfContained), un raccourci dans le
; menu Demarrer (et sur le bureau si on le coche), une entree dans « Applications installees ». Si le
; runtime WebView2 manque (Windows 10 ancien), il est telecharge et installe au passage.
; Les donnees (%LOCALAPPDATA%\Organizator) ne sont jamais touchees, ni a la mise a jour ni a la
; desinstallation. Relancer un installateur plus recent met a jour en place (meme AppId).
;
; Construit par .github/workflows/organizator.yml, ou a la main :
;   publish.ps1 -SelfContained -Installer
;   ISCC.exe /DAppVersion=1.2.3 installer\Organizator.iss

#ifndef AppVersion
  #define AppVersion "1.0.0"
#endif
#ifndef PublishDir
  #define PublishDir "..\publish"
#endif

[Setup]
AppId={{7E3B9C41-58A2-4F6D-9B1E-2C7A4D0F8E65}
AppName=Organizator
AppVersion={#AppVersion}
AppVerName=Organizator {#AppVersion}
AppPublisher=Organizator
DefaultDirName={localappdata}\Programs\Organizator
DefaultGroupName=Organizator
DisableProgramGroupPage=yes
DisableDirPage=yes
DisableReadyPage=yes
PrivilegesRequired=lowest
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
MinVersion=10.0.17763
OutputDir=..\publish\installer
OutputBaseFilename=Organizator-Setup-{#AppVersion}
SetupIconFile=..\src\Organizator\app.ico
UninstallDisplayIcon={app}\Organizator.exe
UninstallDisplayName=Organizator
Compression=lzma2/max
SolidCompression=yes
WizardStyle=modern
; Organizator ouvert pendant une mise a jour : il est ferme, puis relance a la fin.
CloseApplications=force
RestartApplications=no

[Languages]
Name: "fr"; MessagesFile: "compiler:Languages\French.isl"

[Tasks]
Name: "desktopicon"; Description: "Créer une icône sur le bureau"; GroupDescription: "Raccourcis :"

[Files]
Source: "{#PublishDir}\Organizator.exe"; DestDir: "{app}"; Flags: ignoreversion

[Icons]
Name: "{autoprograms}\Organizator"; Filename: "{app}\Organizator.exe"
Name: "{autodesktop}\Organizator"; Filename: "{app}\Organizator.exe"; Tasks: desktopicon

[Run]
Filename: "{app}\Organizator.exe"; Description: "Lancer Organizator"; Flags: nowait postinstall skipifsilent

[Code]
const
  WebView2Key = 'SOFTWARE\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}';
  WebView2Bootstrapper = 'https://go.microsoft.com/fwlink/p/?LinkId=2124703';

function HasVersion(Root: Integer; Key: String): Boolean;
var
  Version: String;
begin
  Result := RegQueryStringValue(Root, Key, 'pv', Version) and (Version <> '') and (Version <> '0.0.0.0');
end;

{ Runtime WebView2 present pour la machine (cle 32 bits sous Windows 64 bits) ou pour l'utilisateur. }
function HasWebView2(): Boolean;
begin
  Result := HasVersion(HKLM32, WebView2Key) or HasVersion(HKLM64, WebView2Key) or HasVersion(HKCU, WebView2Key);
end;

{ Sans WebView2, Organizator n'affiche rien : on installe le runtime (installeur « Evergreen » de Microsoft). }
procedure InstallWebView2();
var
  Code: Integer;
begin
  WizardForm.StatusLabel.Caption := 'Installation du runtime Microsoft Edge WebView2…';
  try
    DownloadTemporaryFile(WebView2Bootstrapper, 'MicrosoftEdgeWebview2Setup.exe', '', nil);
    if not Exec(ExpandConstant('{tmp}\MicrosoftEdgeWebview2Setup.exe'), '/silent /install', '', SW_HIDE, ewWaitUntilTerminated, Code) or (Code <> 0) then
      MsgBox('Le runtime WebView2 ne s''est pas installé (code ' + IntToStr(Code) + '). Installez-le depuis https://go.microsoft.com/fwlink/p/?LinkId=2124703 puis relancez Organizator.', mbError, MB_OK);
  except
    MsgBox('Téléchargement du runtime WebView2 impossible : ' + GetExceptionMessage + #13#10 + 'Installez-le depuis https://go.microsoft.com/fwlink/p/?LinkId=2124703 puis relancez Organizator.', mbError, MB_OK);
  end;
end;

procedure CurStepChanged(CurStep: TSetupStep);
begin
  if (CurStep = ssPostInstall) and not HasWebView2() then
    InstallWebView2();
end;
