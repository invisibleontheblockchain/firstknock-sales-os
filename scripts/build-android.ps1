$env:JAVA_HOME="C:\Program Files\Android\Android Studio\jbr"
if (!(Test-Path $env:JAVA_HOME)) {
    Write-Error "Java not found at $env:JAVA_HOME. Please install Android Studio or set JAVA_HOME manually."
    exit 1
}

Set-Location "$PSScriptRoot\..\android"
.\gradlew.bat assembleDebug
Write-Host "Build complete. APK is at android\app\build\outputs\apk\debug\app-debug.apk"
