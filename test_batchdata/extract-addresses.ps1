# extract-addresses.ps1
# Reads one or more Redfin CSV exports and writes a clean address .txt
# Usage: .\test_batchdata\extract-addresses.ps1 -CsvFiles test_1715.csv,test_1721.csv -Out test_batchdata\route_addresses.txt

param(
    [string[]]$CsvFiles = @("test_1715.csv","test_1721.csv","test_1802.csv"),
    [string]$Out = "test_batchdata\route_addresses.txt"
)

$addresses = [System.Collections.Generic.HashSet[string]]::new()

foreach ($file in $CsvFiles) {
    if (-not (Test-Path $file)) { Write-Warning "Skipping missing file: $file"; continue }
    $rows = Import-Csv $file
    foreach ($row in $rows) {
        $addr  = $row.ADDRESS?.Trim()
        $city  = $row.CITY?.Trim()
        $state = $row.'STATE OR PROVINCE'?.Trim()
        $zip   = $row.ZIP?.Trim()
        if (-not $addr) { continue }

        $full = if ($city -and $state -and $zip) {
            "$addr, $city, $state $zip"
        } elseif ($city -and $state) {
            "$addr, $city, $state"
        } else {
            $addr
        }
        [void]$addresses.Add($full)
    }
}

$sorted = $addresses | Sort-Object
$sorted | Set-Content $Out -Encoding UTF8
Write-Host "✅  Wrote $($sorted.Count) unique addresses to $Out"
