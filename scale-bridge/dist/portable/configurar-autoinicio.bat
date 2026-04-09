@echo off
cls
echo Configurando el inicio automatico de la balanza...
set VBSCRIPT="%temp%\CreateShortcut.vbs"
echo Set oWS = WScript.CreateObject("WScript.Shell") > %VBSCRIPT%
echo sLinkFile = oWS.SpecialFolders("Startup") ^& "\PuenteBalanzaPOS.lnk" >> %VBSCRIPT%
echo Set oLink = oWS.CreateShortcut(sLinkFile) >> %VBSCRIPT%
echo oLink.TargetPath = "%~dp0start-balanza.bat" >> %VBSCRIPT%
echo oLink.WorkingDirectory = "%~dp0" >> %VBSCRIPT%
echo oLink.WindowStyle = 7 >> %VBSCRIPT%
echo oLink.Save >> %VBSCRIPT%
cscript /nologo %VBSCRIPT%
del %VBSCRIPT%
echo.
echo LISTO! El puente arrancara solo y minimizado cada vez que prendas esta PC.
pause
