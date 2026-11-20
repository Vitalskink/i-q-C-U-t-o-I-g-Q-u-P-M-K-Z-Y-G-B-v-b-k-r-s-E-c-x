#pragma header

uniform float size;

void main()
{
    vec2 uv = openfl_TextureCoordv;
    vec2 resolution = openfl_TextureSize;

    if (size <= 0.0)
    {
        gl_FragColor = flixel_texture2D(bitmap, uv);
        return;
    }

    float px = resolution.x * size / 500.0;
    float py = resolution.y * size / 275.0;

    vec2 pixelSize = vec2(px / resolution.x, py / resolution.y);

    uv = floor(uv / pixelSize) * pixelSize;

    gl_FragColor = flixel_texture2D(bitmap, uv);
}