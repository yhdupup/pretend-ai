import AvatarPicker from "./AvatarPicker";

interface Props {
  /** 内置头像编号：没上传自定义图时，B 揭晓卡片上就是它。 */
  avatarId: string;
  /** A 上传的身份头像（data URL，空串=用内置）。 */
  avatarData: string;
  onAvatarId: (next: string) => void;
  onAvatarData: (next: string) => void;
}

// A 的身份头像选择器：内置四个 + 自己的那张脸（点按钮选文件 / ⌘V 粘贴 / 拖进来三条进法）。
// 只影响揭晓后 B 看到的那张卡片（PRD §7.5）；假 AI 那张脸在下面的第 02 段，同一个组件的另一个档。
//
// 2026-09-13 起这里只是 AvatarPicker 的一层皮：假 AI 的头像也要能上传之后，
// 两套「点选/粘贴/拖拽 + 全局监听仲裁」不能各写一遍——否则同一张图会被两个监听同时吃掉。
export default function OwnerAvatarPicker({
  avatarId,
  avatarData,
  onAvatarId,
  onAvatarData,
}: Props) {
  return (
    <AvatarPicker
      variant="owner"
      avatarId={avatarId}
      avatarData={avatarData}
      onAvatarId={onAvatarId}
      onAvatarData={onAvatarData}
    />
  );
}
