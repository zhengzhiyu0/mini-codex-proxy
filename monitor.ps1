param(
  [string]$ProxyUrl = 'http://127.0.0.1:8317',
  [int]$RefreshIntervalMs = 250,
  [string]$ConfigPath
)

$ErrorActionPreference = 'Stop'

Add-Type -AssemblyName PresentationCore
Add-Type -AssemblyName PresentationFramework
Add-Type -AssemblyName WindowsBase

$projectRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
if ([string]::IsNullOrWhiteSpace($ConfigPath)) {
  $ConfigPath = if (-not [string]::IsNullOrWhiteSpace($env:MINI_CODEX_PROXY_CONFIG)) {
    $env:MINI_CODEX_PROXY_CONFIG
  } else {
    Join-Path $projectRoot 'config.json'
  }
}

$themeName = 'dark-green'
try {
  if (Test-Path -LiteralPath $ConfigPath) {
    $monitorConfig = (Get-Content -LiteralPath $ConfigPath -Raw -Encoding UTF8 | ConvertFrom-Json).monitor
    if ($monitorConfig.theme) { $themeName = [string]$monitorConfig.theme }
  }
} catch {
  # 配置读取失败不影响监控功能，使用默认主题。
}

$themeAliases = @{
  'dark'  = 'dark-green'
  'light' = 'light-mint'
}
$themeName = $themeName.Trim().ToLowerInvariant()
if ($themeAliases.ContainsKey($themeName)) { $themeName = $themeAliases[$themeName] }

$themes = @{
  'dark-green' = @{
    Window = '#F00E1B16'; Border = '#365B4B'; Shadow = '#CC000000'; ShadowOpacity = 0.62
    Surface = '#0C1814'; SurfaceAlt = '#101F19'; Divider = '#284638'
    Text = '#D9EEE5'; TextSoft = '#91B7A7'; Muted = '#557C6C'; Faint = '#294C3D'
    Button = '#6FA58E'; ButtonHover = '#17382A'; ButtonHoverText = '#A8E6C7'
    Accent = '#34D399'; AccentSoft = '#0B261A'; AccentBorder = '#1C5136'; Danger = '#D66A6A'
  }
  'light-mint' = @{
    Window = '#FAFDFB'; Border = '#A8CDBA'; Shadow = '#660F2A1E'; ShadowOpacity = 0.22
    Surface = '#FFFFFF'; SurfaceAlt = '#EFF8F3'; Divider = '#D2E7DC'
    Text = '#173D2D'; TextSoft = '#3F6E59'; Muted = '#6E9180'; Faint = '#A3BCAF'
    Button = '#477762'; ButtonHover = '#DDF2E7'; ButtonHoverText = '#17613F'
    Accent = '#18794E'; AccentSoft = '#E5F6EC'; AccentBorder = '#A9D9BF'; Danger = '#B42318'
  }
  'light-ivory' = @{
    Window = '#FFFCF5'; Border = '#D7CDB4'; Shadow = '#594A3A24'; ShadowOpacity = 0.20
    Surface = '#FFFFFF'; SurfaceAlt = '#F8F2E5'; Divider = '#E9DFC9'
    Text = '#3D382C'; TextSoft = '#716752'; Muted = '#91856D'; Faint = '#B9AE98'
    Button = '#746A55'; ButtonHover = '#F1E8D5'; ButtonHoverText = '#51462F'
    Accent = '#34785A'; AccentSoft = '#E8F3EC'; AccentBorder = '#B7D2C0'; Danger = '#B42318'
  }
  'light-sky' = @{
    Window = '#F7FBFF'; Border = '#AFC9DC'; Shadow = '#55354F63'; ShadowOpacity = 0.20
    Surface = '#FFFFFF'; SurfaceAlt = '#EDF6FC'; Divider = '#D5E6F1'
    Text = '#19384C'; TextSoft = '#456B82'; Muted = '#718FA1'; Faint = '#A8BECA'
    Button = '#4E7185'; ButtonHover = '#DCEEF8'; ButtonHoverText = '#195B7C'
    Accent = '#167A72'; AccentSoft = '#E1F4F1'; AccentBorder = '#A8D9D3'; Danger = '#B42318'
  }
}
if (-not $themes.ContainsKey($themeName)) { $themeName = 'dark-green' }
$theme = $themes[$themeName]
$script:isLightTheme = $themeName.StartsWith('light-')

[xml]$xaml = @'
<Window xmlns="http://schemas.microsoft.com/winfx/2006/xaml/presentation"
        xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml"
        Width="560" Height="46" MinWidth="500" MinHeight="46"
        WindowStartupLocation="Manual" Left="30" Top="30"
        WindowStyle="None" ResizeMode="CanResize"
        AllowsTransparency="True" Topmost="True" ShowInTaskbar="True"
        Background="Transparent" Title="mini-codex-proxy monitor">
  <Window.Resources>
    <SolidColorBrush x:Key="Theme.Window" Color="#F00E1B16"/>
    <SolidColorBrush x:Key="Theme.Border" Color="#365B4B"/>
    <SolidColorBrush x:Key="Theme.Surface" Color="#0C1814"/>
    <SolidColorBrush x:Key="Theme.SurfaceAlt" Color="#101F19"/>
    <SolidColorBrush x:Key="Theme.Divider" Color="#284638"/>
    <SolidColorBrush x:Key="Theme.Text" Color="#D9EEE5"/>
    <SolidColorBrush x:Key="Theme.TextSoft" Color="#91B7A7"/>
    <SolidColorBrush x:Key="Theme.Muted" Color="#557C6C"/>
    <SolidColorBrush x:Key="Theme.Faint" Color="#294C3D"/>
    <SolidColorBrush x:Key="Theme.Button" Color="#6FA58E"/>
    <SolidColorBrush x:Key="Theme.ButtonHover" Color="#17382A"/>
    <SolidColorBrush x:Key="Theme.ButtonHoverText" Color="#A8E6C7"/>
    <SolidColorBrush x:Key="Theme.Accent" Color="#34D399"/>
    <SolidColorBrush x:Key="Theme.AccentSoft" Color="#0B261A"/>
    <SolidColorBrush x:Key="Theme.AccentBorder" Color="#1C5136"/>
    <SolidColorBrush x:Key="Theme.Danger" Color="#D66A6A"/>
    <Style x:Key="IconBtn" TargetType="Button">
      <Setter Property="Width" Value="26"/>
      <Setter Property="Height" Value="26"/>
      <Setter Property="Margin" Value="2,0,0,0"/>
      <Setter Property="Foreground" Value="{DynamicResource Theme.Button}"/>
      <Setter Property="Background" Value="Transparent"/>
      <Setter Property="BorderThickness" Value="0"/>
      <Setter Property="FontSize" Value="14"/>
      <Setter Property="Cursor" Value="Hand"/>
      <Setter Property="Template">
        <Setter.Value>
          <ControlTemplate TargetType="Button">
            <Border Background="{TemplateBinding Background}" CornerRadius="5">
              <ContentPresenter HorizontalAlignment="Center" VerticalAlignment="Center"/>
            </Border>
          </ControlTemplate>
        </Setter.Value>
      </Setter>
      <Style.Triggers>
        <Trigger Property="IsMouseOver" Value="True">
          <Setter Property="Background" Value="{DynamicResource Theme.ButtonHover}"/>
          <Setter Property="Foreground" Value="{DynamicResource Theme.ButtonHoverText}"/>
        </Trigger>
      </Style.Triggers>
    </Style>
    <Style x:Key="Chip" TargetType="Border">
      <Setter Property="Background" Value="{DynamicResource Theme.SurfaceAlt}"/>
      <Setter Property="BorderBrush" Value="{DynamicResource Theme.Border}"/>
      <Setter Property="BorderThickness" Value="1"/>
      <Setter Property="CornerRadius" Value="5"/>
      <Setter Property="Padding" Value="7,3"/>
      <Setter Property="Margin" Value="4,0,0,0"/>
    </Style>
    <Style x:Key="Card" TargetType="Border">
      <Setter Property="Background" Value="{DynamicResource Theme.Surface}"/>
      <Setter Property="BorderBrush" Value="{DynamicResource Theme.Divider}"/>
      <Setter Property="BorderThickness" Value="1"/>
      <Setter Property="CornerRadius" Value="8"/>
      <Setter Property="Padding" Value="12,8"/>
      <Setter Property="Margin" Value="0,0,6,6"/>
    </Style>
  </Window.Resources>
  <Border x:Name="RootBorder" CornerRadius="12" Padding="1"
          Background="{DynamicResource Theme.Window}" BorderBrush="{DynamicResource Theme.Border}" BorderThickness="1">
    <Border.Effect>
      <DropShadowEffect BlurRadius="26" ShadowDepth="5" Direction="270" Color="#CC000000" Opacity="0.65"/>
    </Border.Effect>
    <Grid>
      <Grid.RowDefinitions>
        <RowDefinition Height="46"/>
        <RowDefinition Height="*"/>
        <RowDefinition Height="Auto"/>
      </Grid.RowDefinitions>
      <!-- Compact bar -->
      <Grid x:Name="TitleBar" Grid.Row="0" Margin="2,0,2,0">
        <Grid.ColumnDefinitions>
          <ColumnDefinition Width="*"/>
          <ColumnDefinition Width="Auto"/>
          <ColumnDefinition Width="Auto"/>
        </Grid.ColumnDefinitions>
        <!-- Request summary; brand title deliberately omitted for a smaller status bar. -->
        <Grid Grid.Column="0" VerticalAlignment="Center" Margin="8,0,4,0">
          <Grid.ColumnDefinitions>
            <ColumnDefinition Width="Auto"/>
            <ColumnDefinition Width="*" MinWidth="24"/>
            <ColumnDefinition Width="Auto"/>
            <ColumnDefinition Width="Auto"/>
            <ColumnDefinition Width="Auto"/>
            <ColumnDefinition Width="Auto"/>
            <ColumnDefinition Width="Auto"/>
          </Grid.ColumnDefinitions>
          <Border Grid.Column="0" x:Name="MethodBadgeBorder" CornerRadius="4" Padding="5,2" Margin="0,0,5,0"
                  Background="{DynamicResource Theme.SurfaceAlt}" BorderBrush="{DynamicResource Theme.Divider}" BorderThickness="1">
            <TextBlock x:Name="MethodBadgeText" Foreground="{DynamicResource Theme.TextSoft}" FontSize="10" FontWeight="Bold"
                       FontFamily="Cascadia Code,Consolas,monospace" Text="--"/>
          </Border>
          <TextBlock Grid.Column="1" x:Name="PathText" Foreground="{DynamicResource Theme.TextSoft}" FontSize="10"
                     FontFamily="Cascadia Code,Consolas,monospace"
                     TextTrimming="CharacterEllipsis" VerticalAlignment="Center"
                     Text="—" Margin="0,0,5,0"/>
          <!-- hidden model text kept for compat; invisible -->
          <TextBlock x:Name="ModelCompactText" Visibility="Collapsed" Text="--"/>
          <!-- Status code -->
          <Border Grid.Column="2" x:Name="StatusCodeBorder" CornerRadius="4" Padding="5,2" Margin="0,0,5,0"
                  Background="{DynamicResource Theme.AccentSoft}" BorderBrush="{DynamicResource Theme.AccentBorder}" BorderThickness="1">
            <TextBlock x:Name="StatusCodeText" Foreground="{DynamicResource Theme.Accent}" FontSize="10" FontWeight="SemiBold"
                       FontFamily="Cascadia Code,Consolas,monospace" Text="--"/>
          </Border>
          <!-- ↑ bytes -->
          <StackPanel Grid.Column="3" Orientation="Horizontal" VerticalAlignment="Center" Margin="0,0,5,0">
            <TextBlock Foreground="{DynamicResource Theme.Muted}" FontSize="9" VerticalAlignment="Center" Text="↑" Margin="0,0,2,0"/>
            <TextBlock x:Name="MetricUpText" Foreground="{DynamicResource Theme.TextSoft}" FontSize="10" FontWeight="SemiBold"
                       FontFamily="Cascadia Code,Consolas,monospace" VerticalAlignment="Center" Text="--"/>
          </StackPanel>
          <!-- ↓ bytes -->
          <StackPanel Grid.Column="4" Orientation="Horizontal" VerticalAlignment="Center" Margin="0,0,5,0">
            <TextBlock Foreground="{DynamicResource Theme.Muted}" FontSize="9" VerticalAlignment="Center" Text="↓" Margin="0,0,2,0"/>
            <TextBlock x:Name="MetricDownText" Foreground="{DynamicResource Theme.Accent}" FontSize="10" FontWeight="SemiBold"
                       FontFamily="Cascadia Code,Consolas,monospace" VerticalAlignment="Center" Text="--"/>
          </StackPanel>
          <!-- first output -->
          <StackPanel Grid.Column="5" Orientation="Horizontal" VerticalAlignment="Center" Margin="0,0,5,0">
            <TextBlock Foreground="{DynamicResource Theme.Muted}" FontSize="9" VerticalAlignment="Center" Text="首字" Margin="0,0,2,0"/>
            <TextBlock x:Name="MetricFirstText" Foreground="{DynamicResource Theme.TextSoft}" FontSize="10" FontWeight="SemiBold"
                       FontFamily="Cascadia Code,Consolas,monospace" VerticalAlignment="Center" Text="--"/>
          </StackPanel>
          <!-- total time -->
          <TextBlock Grid.Column="6" x:Name="MetricTotalText" Foreground="{DynamicResource Theme.Text}" FontSize="10" FontWeight="SemiBold"
                     FontFamily="Cascadia Code,Consolas,monospace" VerticalAlignment="Center" Text="--"/>
        </Grid>
        <!-- Status pill -->
        <Border x:Name="StatusPill" Grid.Column="1" CornerRadius="7" Padding="7,3"
                Margin="0,0,5,0" Background="{DynamicResource Theme.AccentSoft}" BorderBrush="{DynamicResource Theme.AccentBorder}" BorderThickness="1">
          <StackPanel Orientation="Horizontal" VerticalAlignment="Center">
            <Ellipse x:Name="StatusDot" Width="5" Height="5" Fill="{DynamicResource Theme.Accent}"
                     VerticalAlignment="Center" Margin="0,0,4,0"/>
            <TextBlock x:Name="StateText" Foreground="{DynamicResource Theme.Accent}" FontSize="9" FontWeight="SemiBold"
                       FontFamily="Segoe UI" Text="代理运行中" TextWrapping="NoWrap"/>
            <TextBlock x:Name="ActiveCountText" Foreground="{DynamicResource Theme.Muted}" FontSize="9"
                       Margin="4,0,0,0" Text="·0" TextWrapping="NoWrap"/>
          </StackPanel>
        </Border>
        <!-- Buttons -->
        <StackPanel Grid.Column="2" Orientation="Horizontal" VerticalAlignment="Center" Margin="0,0,7,0">
          <Button x:Name="HistoryButton" Style="{StaticResource IconBtn}" Content="◷" FontFamily="Segoe UI Symbol" ToolTip="查看历史"/>
          <Button x:Name="ExpandButton"  Style="{StaticResource IconBtn}" Content="⤢" FontFamily="Segoe UI Symbol" ToolTip="展开详情"/>
          <Button x:Name="CollapseButton" Style="{StaticResource IconBtn}" Content="—" ToolTip="折叠"/>
          <Button x:Name="CloseButton"   Style="{StaticResource IconBtn}" Content="×" Foreground="{DynamicResource Theme.Danger}" ToolTip="关闭"/>
        </StackPanel>
      </Grid>
      <!-- Details panel -->
      <StackPanel x:Name="DetailsPanel" Grid.Row="1" Margin="10,6,10,0" Visibility="Collapsed">
        <Border Background="{DynamicResource Theme.Surface}" BorderBrush="{DynamicResource Theme.Divider}" BorderThickness="1"
                CornerRadius="8" Padding="12,8" Margin="0,0,0,8">
          <Grid>
            <Grid.RowDefinitions>
              <RowDefinition Height="Auto"/>
              <RowDefinition Height="Auto"/>
            </Grid.RowDefinitions>
            <TextBlock x:Name="RequestText" Foreground="{DynamicResource Theme.Text}" FontSize="11" FontWeight="SemiBold"
                       FontFamily="Cascadia Code,Consolas,monospace" Text="暂无请求"/>
            <StackPanel Grid.Row="1" Orientation="Horizontal" Margin="0,4,0,0">
              <TextBlock x:Name="ModelText" Foreground="{DynamicResource Theme.TextSoft}" FontSize="10" Text="模型：--"/>
              <TextBlock Text="  ·  " Foreground="{DynamicResource Theme.Faint}" FontSize="10"/>
              <TextBlock x:Name="UpstreamText" Foreground="{DynamicResource Theme.Muted}" FontSize="10" Text="上游：--"/>
            </StackPanel>
          </Grid>
        </Border>
        <Grid>
          <Grid.RowDefinitions>
            <RowDefinition Height="Auto"/>
            <RowDefinition Height="Auto"/>
          </Grid.RowDefinitions>
          <Grid.ColumnDefinitions>
            <ColumnDefinition Width="*"/>
            <ColumnDefinition Width="*"/>
          </Grid.ColumnDefinitions>
          <Border Style="{StaticResource Card}">
            <StackPanel>
              <TextBlock Foreground="{DynamicResource Theme.Faint}" FontSize="8" FontFamily="Segoe UI" Text="REQUEST"/>
              <TextBlock x:Name="RequestBytesText" Foreground="{DynamicResource Theme.TextSoft}" FontSize="14" FontWeight="SemiBold"
                         FontFamily="Cascadia Code,Consolas,monospace" Margin="0,3,0,0" Text="↑ --"/>
            </StackPanel>
          </Border>
          <Border Grid.Column="1" Style="{StaticResource Card}">
            <StackPanel>
              <TextBlock Foreground="{DynamicResource Theme.Faint}" FontSize="8" FontFamily="Segoe UI" Text="RESPONSE"/>
              <TextBlock x:Name="ResponseBytesText" Foreground="{DynamicResource Theme.Accent}" FontSize="14" FontWeight="SemiBold"
                         FontFamily="Cascadia Code,Consolas,monospace" Margin="0,3,0,0" Text="↓ --"/>
            </StackPanel>
          </Border>
          <Border Grid.Row="1" Style="{StaticResource Card}">
            <StackPanel>
              <TextBlock Foreground="{DynamicResource Theme.Faint}" FontSize="8" FontFamily="Segoe UI" Text="FIRST BYTE"/>
              <TextBlock x:Name="FirstByteText" Foreground="{DynamicResource Theme.TextSoft}" FontSize="13" FontWeight="SemiBold"
                         FontFamily="Cascadia Code,Consolas,monospace" Margin="0,3,0,0" Text="--"/>
            </StackPanel>
          </Border>
          <Border Grid.Row="1" Grid.Column="1" Style="{StaticResource Card}">
            <StackPanel>
              <TextBlock Foreground="{DynamicResource Theme.Faint}" FontSize="8" FontFamily="Segoe UI" Text="FIRST OUTPUT"/>
              <TextBlock x:Name="FirstTextText" Foreground="{DynamicResource Theme.Text}" FontSize="13" FontWeight="SemiBold"
                         FontFamily="Cascadia Code,Consolas,monospace" Margin="0,3,0,0" Text="--"/>
            </StackPanel>
          </Border>
        </Grid>
      </StackPanel>
      <!-- History panel -->
      <Grid x:Name="HistoryPanel" Grid.Row="1" Margin="10,8,10,0" Visibility="Collapsed">
        <Grid.RowDefinitions>
          <RowDefinition Height="Auto"/>
          <RowDefinition Height="*"/>
        </Grid.RowDefinitions>
        <StackPanel Orientation="Horizontal" Margin="0,0,0,6">
          <TextBlock Foreground="{DynamicResource Theme.Text}" FontSize="11" FontWeight="SemiBold" FontFamily="Segoe UI" Text="本次启动历史"/>
          <TextBlock x:Name="HistoryCountText" Foreground="{DynamicResource Theme.Muted}" FontSize="10" Margin="8,1,0,0" Text="0 条"/>
        </StackPanel>
        <Border Grid.Row="1" Background="{DynamicResource Theme.Surface}" BorderBrush="{DynamicResource Theme.Divider}" BorderThickness="1"
                CornerRadius="8" Padding="10,6">
          <ScrollViewer VerticalScrollBarVisibility="Auto" HorizontalScrollBarVisibility="Disabled">
            <TextBlock x:Name="HistoryText" Foreground="{DynamicResource Theme.TextSoft}" FontSize="10"
                       FontFamily="Cascadia Code,Consolas,monospace" Text="暂无已完成请求" TextWrapping="Wrap"/>
          </ScrollViewer>
        </Border>
      </Grid>
      <!-- Footer -->
      <Grid x:Name="FooterPanel" Grid.Row="2" Margin="12,4,12,8" Visibility="Collapsed">
        <TextBlock x:Name="TimingText" Foreground="{DynamicResource Theme.Muted}" FontSize="9"
                   FontFamily="Segoe UI" VerticalAlignment="Center" Text="总耗时 --"/>
        <StackPanel Orientation="Horizontal" HorizontalAlignment="Right" VerticalAlignment="Center">
          <TextBlock x:Name="UpdatedText" Foreground="{DynamicResource Theme.Faint}" FontSize="9"
                     VerticalAlignment="Center" Text="等待状态" Margin="0,0,8,0"/>
          <Button x:Name="RefreshButton" Content="刷新" Padding="8,2" Cursor="Hand"
                  Foreground="{DynamicResource Theme.Accent}" Background="{DynamicResource Theme.AccentSoft}" BorderBrush="{DynamicResource Theme.AccentBorder}"
                  BorderThickness="1" FontSize="10"/>
        </StackPanel>
      </Grid>
    </Grid>
  </Border>
</Window>
'@

$reader = New-Object System.Xml.XmlNodeReader $xaml
$window = [Windows.Markup.XamlReader]::Load($reader)

function Get-Control([string]$name) { return $window.FindName($name) }

function New-Color([string]$value) {
  return [Windows.Media.ColorConverter]::ConvertFromString($value)
}

function New-Brush([string]$value) {
  return [Windows.Media.SolidColorBrush]::new((New-Color $value))
}

foreach ($resourceName in @(
  'Window', 'Border', 'Surface', 'SurfaceAlt', 'Divider', 'Text', 'TextSoft', 'Muted', 'Faint',
  'Button', 'ButtonHover', 'ButtonHoverText', 'Accent', 'AccentSoft', 'AccentBorder', 'Danger'
)) {
  $window.Resources["Theme.$resourceName"] = New-Brush $theme[$resourceName]
}

$rootBorder        = Get-Control 'RootBorder'
$rootShadow        = $rootBorder.Effect
$titleBar          = Get-Control 'TitleBar'
$methodBadgeBorder = Get-Control 'MethodBadgeBorder'
$methodBadgeText   = Get-Control 'MethodBadgeText'
$pathText          = Get-Control 'PathText'
$modelCompactText  = Get-Control 'ModelCompactText'
$statusCodeBorder  = Get-Control 'StatusCodeBorder'
$statusCodeText    = Get-Control 'StatusCodeText'
$metricUpText      = Get-Control 'MetricUpText'
$metricDownText    = Get-Control 'MetricDownText'
$metricFirstText   = Get-Control 'MetricFirstText'
$metricTotalText   = Get-Control 'MetricTotalText'
$detailsPanel      = Get-Control 'DetailsPanel'
$stateText         = Get-Control 'StateText'
$activeCountText   = Get-Control 'ActiveCountText'
$requestText       = Get-Control 'RequestText'
$modelText         = Get-Control 'ModelText'
$upstreamText      = Get-Control 'UpstreamText'
$statusPill        = Get-Control 'StatusPill'
$statusDot         = Get-Control 'StatusDot'
$requestBytesText  = Get-Control 'RequestBytesText'
$responseBytesText = Get-Control 'ResponseBytesText'
$firstByteText     = Get-Control 'FirstByteText'
$firstTextText     = Get-Control 'FirstTextText'
$timingText        = Get-Control 'TimingText'
$updatedText       = Get-Control 'UpdatedText'
$refreshButton     = Get-Control 'RefreshButton'
$historyButton     = Get-Control 'HistoryButton'
$expandButton      = Get-Control 'ExpandButton'
$collapseButton    = Get-Control 'CollapseButton'
$closeButton       = Get-Control 'CloseButton'
$historyPanel      = Get-Control 'HistoryPanel'
$footerPanel       = Get-Control 'FooterPanel'
$historyCountText  = Get-Control 'HistoryCountText'
$historyText       = Get-Control 'HistoryText'

$rootShadow.Color   = New-Color $theme.Shadow
$rootShadow.Opacity = $theme.ShadowOpacity

$script:isHistoryVisible = $false
$script:isExpanded       = $false

function Format-Bytes([long]$bytes) {
  if ($bytes -lt 1024)  { return "$bytes B" }
  if ($bytes -lt 1MB)   { return ('{0:N1} KB' -f ($bytes / 1KB)) }
  return ('{0:N1} MB' -f ($bytes / 1MB))
}

function Format-Ms($ms) {
  if ($null -eq $ms) { return '--' }
  return ('{0:N2}s' -f ($ms / 1000))
}

function Format-HistoryItem($item) {
  $status = if ($item.status) { $item.status } else { '--' }
  $model  = if ($item.model -and $item.mappedModel -and $item.model -ne $item.mappedModel) {
    "$($item.model)→$($item.mappedModel)"
  } elseif ($item.model) { $item.model } else { '--' }
  $mark = if ($item.state -eq 'completed') { '✓' } else { '✗' }
  return "$mark  $($item.method) $($item.path)  ·  $model  ·  HTTP $status  ·  $(Format-Ms $item.elapsedMs)"
}

function Update-History($snapshot) {
  $items = @($snapshot.history)
  $historyCountText.Text = "$($items.Count) 条"
  $historyText.Text = if ($items.Count -eq 0) { '暂无已完成请求' } else {
    ($items | ForEach-Object { Format-HistoryItem $_ }) -join "`n"
  }
}

function Set-MethodColor([string]$method) {
  $palette = if ($script:isLightTheme) {
    switch ($method) {
      'GET'    { @('#086D8F', '#E6F6FA', '#A9D8E5') }
      'POST'   { @('#18794E', '#E5F6EC', '#A9D9BF') }
      'DELETE' { @('#B42318', '#FDECEA', '#F0B5AF') }
      'PUT'    { @('#8A6116', '#FFF6D8', '#E8D08C') }
      'PATCH'  { @('#A04B16', '#FFF0E5', '#E8BEA2') }
      default  { @('#6546A5', '#F1ECFB', '#CFC0EB') }
    }
  } else {
    switch ($method) {
      'GET'    { @('#22D3EE', '#0E2030', '#1A4055') }
      'POST'   { @('#34D399', '#0A2018', '#123A25') }
      'DELETE' { @('#F87171', '#2A0F0F', '#4A1515') }
      'PUT'    { @('#FCD34D', '#2A2008', '#4A3A10') }
      'PATCH'  { @('#FDBA74', '#2A1A08', '#4A2A10') }
      default  { @('#A78BFA', '#1A1030', '#2A1A55') }
    }
  }
  $methodBadgeText.Foreground    = New-Brush $palette[0]
  $methodBadgeBorder.Background  = New-Brush $palette[1]
  $methodBadgeBorder.BorderBrush = New-Brush $palette[2]
}

function Set-StatusColor([string]$state) {
  $palette = if ($script:isLightTheme) {
    switch ($state) {
      'completed' { @('#18794E', '#E5F6EC', '#A9D9BF') }
      'failed'    { @('#B42318', '#FDECEA', '#F0B5AF') }
      'streaming' { @('#086D8F', '#E6F6FA', '#A9D8E5') }
      'waiting'   { @('#8A6116', '#FFF6D8', '#E8D08C') }
      default     { @('#315F91', '#EAF2FB', '#B8CCE2') }
    }
  } else {
    switch ($state) {
      'completed' { @('#34D399', '#09180F', '#123020') }
      'failed'    { @('#F87171', '#2A0F0F', '#4A1515') }
      'streaming' { @('#22D3EE', '#0E2030', '#1A4055') }
      'waiting'   { @('#FCD34D', '#2A2008', '#4A3A10') }
      default     { @('#93C5FD', '#0A1530', '#152845') }
    }
  }
  $brush = New-Brush $palette[0]
  $stateText.Foreground  = $brush
  $statusDot.Fill        = $brush
  $statusPill.Background = New-Brush $palette[1]
  $statusPill.BorderBrush= New-Brush $palette[2]
}

function Set-StatusCodeColor([int]$code) {
  $palette = if ($script:isLightTheme) {
    if ($code -ge 500) { @('#B42318', '#FDECEA', '#F0B5AF') }
    elseif ($code -ge 400) { @('#A04B16', '#FFF0E5', '#E8BEA2') }
    elseif ($code -ge 200) { @('#18794E', '#E5F6EC', '#A9D9BF') }
    else { @('#315F91', '#EAF2FB', '#B8CCE2') }
  } else {
    if ($code -ge 500) { @('#F87171', '#2A0F0F', '#4A1515') }
    elseif ($code -ge 400) { @('#FDBA74', '#2A1A08', '#4A2A10') }
    elseif ($code -ge 200) { @('#34D399', '#0A1F14', '#123220') }
    else { @('#93C5FD', '#0A1530', '#152845') }
  }
  $statusCodeText.Foreground    = New-Brush $palette[0]
  $statusCodeBorder.Background  = New-Brush $palette[1]
  $statusCodeBorder.BorderBrush = New-Brush $palette[2]
}

function Update-View($snapshot) {
  Update-History $snapshot
  $activeCountText.Text = "· $($snapshot.activeCount)"
  $req = $snapshot.latest
  if ($null -eq $req) {
    $stateText.Text = if ($snapshot.online) { '● 代理运行中' } else { '○ 代理不可用' }
    Set-StatusColor 'completed'
    $methodBadgeText.Text   = '--'
    $pathText.Text          = '—'
    $modelCompactText.Text  = '--'
    $statusCodeText.Text    = '--'
    $metricUpText.Text      = '--'; $metricDownText.Text = '--'
    $metricFirstText.Text   = '--'; $metricTotalText.Text= '--'
    $requestText.Text       = '暂无请求'
    $modelText.Text         = '模型：--'
    $upstreamText.Text      = '上游：--'
    $requestBytesText.Text  = '↑ --'
    $responseBytesText.Text = '↓ --'
    $firstByteText.Text     = '--'
    $firstTextText.Text     = '--'
    $timingText.Text        = '总耗时 --'
  } else {
    $stateLabel = switch ($req.state) {
      'completed' { '✓ 已完成' }
      'failed'    { '✗ 请求失败' }
      'streaming' { '● 流式传输中' }
      'waiting'   { '◌ 等待响应' }
      default     { '◌ 连接上游中' }
    }
    $stateText.Text = $stateLabel
    Set-StatusColor $req.state
    $methodBadgeText.Text = if ($req.method) { $req.method } else { '--' }
    Set-MethodColor ($req.method ?? '--')
    $pathText.Text = $req.path ?? '—'
    $model = if ($req.model -and $req.mappedModel -and $req.model -ne $req.mappedModel) {
      "$($req.model) → $($req.mappedModel)"
    } else { $req.model ?? '--' }
    $modelCompactText.Text  = $model
    $statusCodeText.Text    = if ($req.status) { "$($req.status)" } else { '--' }
    if ($req.status) { Set-StatusCodeColor ([int]$req.status) }
    $metricUpText.Text      = Format-Bytes $req.requestBytes
    $metricDownText.Text    = Format-Bytes $req.responseBytes
    $metricFirstText.Text   = Format-Ms $req.firstOutputTextMs
    $metricTotalText.Text   = Format-Ms $req.elapsedMs
    $requestText.Text       = "#$($req.id)  $($req.method) $($req.path)  HTTP $($req.status ?? '--')"
    $modelText.Text         = "模型：$model"
    $upstreamText.Text      = "上游：$($req.upstream ?? '--')"
    $requestBytesText.Text  = "↑ $(Format-Bytes $req.requestBytes)"
    $responseBytesText.Text = "↓ $(Format-Bytes $req.responseBytes)"
    $firstByteText.Text     = Format-Ms $req.firstByteMs
    $firstTextText.Text     = Format-Ms $req.firstOutputTextMs
    $timingText.Text        = "总耗时 $(Format-Ms $req.elapsedMs)"
  }
  $updatedText.Text = "更新：$(Get-Date -Format 'HH:mm:ss')"
}

function Refresh-Status {
  try {
    $status = Invoke-RestMethod -Uri "$ProxyUrl/_mini/status" -Method Get -TimeoutSec 2
    Update-View $status
  } catch {
    $stateText.Text        = '○ 无法连接代理'
    $activeCountText.Text  = '· --'
    Set-StatusColor 'failed'
    $methodBadgeText.Text  = '!'
    $pathText.Text         = '请先启动 node .\proxy.js'
    $modelCompactText.Text = $ProxyUrl
    $statusCodeText.Text   = '--'
    $metricUpText.Text     = '--'; $metricDownText.Text = '--'
    $metricFirstText.Text  = '--'; $metricTotalText.Text= '--'
    $requestText.Text      = '请先启动 node .\proxy.js'
    $upstreamText.Text     = $ProxyUrl
    $updatedText.Text      = "错误：$(Get-Date -Format 'HH:mm:ss')"
  }
}

function Apply-Layout {
  $detailsPanel.Visibility = if ($script:isExpanded -and -not $script:isHistoryVisible) { 'Visible' } else { 'Collapsed' }
  $historyPanel.Visibility = if ($script:isHistoryVisible) { 'Visible' } else { 'Collapsed' }
  $footerPanel.Visibility  = if ($script:isExpanded -or $script:isHistoryVisible) { 'Visible' } else { 'Collapsed' }
  $window.Width = if ($script:isExpanded) { 680 } else { 560 }
  if ($script:isHistoryVisible)    { $window.Height = if ($script:isExpanded) { 380 } else { 280 } }
  elseif ($script:isExpanded)      { $window.Height = 320 }
  else                             { $window.Height = 46 }
  $historyButton.ToolTip = if ($script:isHistoryVisible) { '返回实时状态' } else { '查看本次启动历史' }
  $expandButton.Content  = if ($script:isExpanded) { '⤡' } else { '⤢' }
  $expandButton.ToolTip  = if ($script:isExpanded) { '还原紧凑横条' } else { '展开查看详情' }
}

$titleBar.Add_MouseLeftButtonDown({ $window.DragMove() })
$refreshButton.Add_Click({ Refresh-Status })
$closeButton.Add_Click({ $window.Close() })
$historyButton.Add_Click({ $script:isHistoryVisible = -not $script:isHistoryVisible; Apply-Layout })
$expandButton.Add_Click({  $script:isExpanded = -not $script:isExpanded; Apply-Layout })
$collapseButton.Add_Click({ $script:isExpanded = $false; $script:isHistoryVisible = $false; Apply-Layout })

$timer = New-Object Windows.Threading.DispatcherTimer
$timer.Interval = [TimeSpan]::FromMilliseconds([Math]::Max(100, $RefreshIntervalMs))
$timer.Add_Tick({ Refresh-Status })
$window.Add_Closed({ $timer.Stop() })

Refresh-Status
Apply-Layout
$timer.Start()
$window.ShowDialog() | Out-Null
