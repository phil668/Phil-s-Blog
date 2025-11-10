---
title: "iOS15.1及以下自定义键盘aria-label兼容实践"
description: "记录在 iOS 15.1 及以下系统中为自定义键盘兼容 aria-label 的排查与优化过程"
pubDate: "2025-03-13"
heroImage: "/a11y.webp"
---

在处理组件库的无障碍需求时，发现自定义键盘在iOS 15.1以下的设备上，按键无法正常选中和读取。键盘按键的DOM结构和无障碍属性大致如下：

```vue
<div
    tabindex="0"
    aria-label="按键A"
>
  <span aria-hidden>A</span>	
 </div>
```

根据[W3C无障碍规范](https://www.w3.org/TR/using-aria/#label-support)，对于aria-label的使用有一些明确的规定。简单来说，不应该在没有语义化的标签（像div和span）上设置aria-label和aria-labelledby属性，除非这些标签上额外设置了role属性。aria-label和aria-labelledby属性应该用在可以交互的标签上，比如a和img。

<img src="/w3c-a11y.png" alt="image-20250313092726016" style="zoom:50%;" />

在明确了问题的原因后，解决方法就很简单了，给外层div加上role属性即可。

```vue
<div
    role="button"
    tabindex="0"
    aria-label="按键A"
>
  <span aria-hidden>A</span>	
 </div>
```

不过，添加role="button"后，朗读内容会多出“button”，也就是说，屏幕阅读器朗读的内容将为“按键A button”。这对于键盘按键需要被高频触发的场景来说，用户体验不佳。因此决定在iOS系统版本低于或等于15.1时，才添加role属性，以兼顾兼容性。

