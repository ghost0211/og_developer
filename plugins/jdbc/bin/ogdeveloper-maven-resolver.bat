@echo off
setlocal

if defined OGDEVELOPER_JAVA_BIN (
    if exist "%OGDEVELOPER_JAVA_BIN%" (
        set "JAVA_BIN=%OGDEVELOPER_JAVA_BIN%"
        goto :run
    )
)

if defined DBX_JAVA_BIN (
    if exist "%DBX_JAVA_BIN%" (
        set "JAVA_BIN=%DBX_JAVA_BIN%"
        goto :run
    )
)

if defined JAVA_HOME (
    if exist "%JAVA_HOME%\bin\java.exe" (
        set "JAVA_BIN=%JAVA_HOME%\bin\java.exe"
        goto :run
    )
)

where java >nul 2>nul
if %errorlevel% equ 0 (
    java -version >nul 2>nul
    if %errorlevel% equ 0 (
        set "JAVA_BIN=java"
        goto :run
    )
)

echo Java runtime not found. Install Java or the optional ogdeveloper JDBC runtime. >&2
exit /b 127

:run
set "JAVA_OPTIONS=%DBX_JAVA_OPTS%"
if defined OGDEVELOPER_JAVA_OPTS set "JAVA_OPTIONS=%OGDEVELOPER_JAVA_OPTS%"
"%JAVA_BIN%" -Dfile.encoding=UTF-8 -Dsun.stdout.encoding=UTF-8 -Dsun.stderr.encoding=UTF-8 -cp "%~dp0..\lib\ogdeveloper-jdbc-plugin.jar" app.ogdeveloper.jdbc.maven.OgdeveloperMavenResolver %*
