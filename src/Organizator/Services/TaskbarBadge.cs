using System.Globalization;
using System.Windows;
using System.Windows.Media;
using System.Windows.Media.Imaging;
using System.Windows.Shell;

namespace Organizator.Services;

/// <summary>
/// Pastille chiffree posee sur le bouton de la fenetre dans la barre des taches : le nombre de
/// notifications non lues, comme les messageries. Rien a zero.
/// </summary>
public static class TaskbarBadge
{
    // Couleur d'accent de l'interface (terracotta), cerclee de blanc pour se detacher de l'icone.
    private static readonly Brush Fill = Freeze(new SolidColorBrush(Color.FromRgb(0xC6, 0x71, 0x39)));
    private static readonly Pen Ring = Freeze(new Pen(Brushes.White, 2));

    public static void Set(Window window, int count)
    {
        window.TaskbarItemInfo ??= new TaskbarItemInfo();
        window.TaskbarItemInfo.Overlay = count > 0 ? Render(window, count) : null;
        window.TaskbarItemInfo.Description = count > 0
            ? count + (count > 1 ? " notifications non lues" : " notification non lue")
            : "";
    }

    private static ImageSource Render(Window window, int count)
    {
        // Windows affiche l'overlay en 16 px logiques : dessine a 32 px pour rester net jusqu'a 200 %.
        const int size = 32;
        var text = count > 9 ? "9+" : count.ToString(CultureInfo.InvariantCulture);
        var visual = new DrawingVisual();
        using (var dc = visual.RenderOpen())
        {
            dc.DrawEllipse(Fill, Ring, new Point(size / 2.0, size / 2.0), size / 2.0 - 1, size / 2.0 - 1);
            var label = new FormattedText(text, CultureInfo.InvariantCulture, FlowDirection.LeftToRight,
                new Typeface(new FontFamily("Segoe UI"), FontStyles.Normal, FontWeights.Bold, FontStretches.Normal),
                count > 9 ? 15 : 19, Brushes.White, VisualTreeHelper.GetDpi(window).PixelsPerDip);
            dc.DrawText(label, new Point((size - label.Width) / 2, (size - label.Height) / 2));
        }

        var bitmap = new RenderTargetBitmap(size, size, 96, 96, PixelFormats.Pbgra32);
        bitmap.Render(visual);
        bitmap.Freeze();
        return bitmap;
    }

    private static T Freeze<T>(T value) where T : Freezable
    {
        value.Freeze();
        return value;
    }
}
