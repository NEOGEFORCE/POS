
$content = Get-Content "C:\Users\jaide\OneDrive\Desktop\POS\backPOS-go\internal\core\services\export_service_consolidated.go" | Out-String
Write-Host "Length: " $content.Length

