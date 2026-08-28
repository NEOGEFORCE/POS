Set WshShell = CreateObject("WScript.Shell")
WshShell.CurrentDirectory = "C:\Users\surti\Desktop\POS\lector-balanza-portatil"
WshShell.Run "node.exe index.js", 0, False

